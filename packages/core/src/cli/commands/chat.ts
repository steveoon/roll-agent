import { loadChatConfigBinding } from "../../runtime-host/chat-config-binding.ts";
import { resolveChatWorkspace } from "../../runtime-host/workspace-identity.ts";
import {
  createChatConfigurationControl,
  type ChatConfigurationControl,
  type ChatOperationLifecycle,
} from "../chat/configuration-control.ts";
import { withReadOnlyChatHistory, readOnlyConversationText } from "../chat/read-only-history.ts";
import type { RuntimeConfigContext, RuntimeConfigOptions } from "../../config/runtime-context.ts";
import {
  createOwnedThreadStore,
  captureSessionLibraryBinding,
} from "../../runtime-host/session-ownership.ts";
import { resolveReasoningPresentation } from "../../llm/reasoning-presentation.ts";
import { ChatGptConnection, type ChatConnection } from "../../runtime-host/chatgpt-connection.ts";
import { createChatGptSessionPreparation } from "../../runtime-host/chatgpt-session-preparation.ts";
import { basename, join } from "node:path";
import { defineCommand } from "citty";
import { isCancel, select } from "@clack/prompts";
import type { AgentSession, EngineModelSwitch } from "@roll-agent/runtime";
import { thinkingProviderOptions, UnsupportedThinkingLevelError } from "../../llm/providers.ts";
import {
  assertChatGptFastModeSupported,
  withChatGptFastMode,
} from "../../llm/chatgpt-fast-mode.ts";
import {
  createChatFastModeControl,
  runFastModeCommand,
  type ChatFastModeControl,
} from "../chat/fast-mode.ts";
import { chatGptThinkingLevels, legacyThinkingLevels } from "../../llm/thinking-levels.ts";
import { resolveAndSwitchChatModel } from "../chat/model-switch.ts";
import { findLlmModelChoice, listLlmModelChoices } from "../../llm/model-choices.ts";
import { writeDefaultLlm } from "../../config/default-llm-writer.ts";
import { getChatGptAuthService } from "../../auth/chatgpt/service.ts";
import {
  resolveInteractiveChatLlm,
  resolveInteractiveChatSwitch,
  chatGptModelChoices,
  chatModelPickerItems,
  chatGptThinkingOptions,
  loadAuthenticatedChatGptModels,
  prepareInteractiveChatReload,
  type ChatGptModels,
} from "../../runtime-host/chatgpt-resolution.ts";
import type { ChatModelSwitching } from "../chat/ink/app.ts";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import chalk from "chalk";
import Table from "cli-table3";
import { log } from "../utils/output.ts";
import { ChatRenderer, clackConfirm, type ChatConfirm } from "../utils/chat-renderer.ts";
import type { ChatCommandResult } from "../../types/chat.ts";
import { CHAT_SCREEN_MODES, type RollConfig } from "../../config/schema.ts";
import { titleFromMessage } from "../chat/title.ts";
import { buildBannerLines, renderBannerText, type BannerInfo } from "../chat/banner.ts";
import {
  CHAT_PRESENTATIONS,
  detectChatTerminalCapabilities,
  resolveChatPresentation,
  resolveChatScreenModeRequest,
} from "../chat/screen-mode.ts";
import { getCurrentVersion } from "../utils/update-checker.ts";
import { formatSkillList, parseSkillInvocation } from "../chat/ink/commands.ts";
import { installCurrentCliShim } from "../utils/current-cli-shim.ts";
import {
  createChatEngineSignalScope,
  type ChatEngineSignalScope,
  type ChatEngineShutdownSignal,
} from "../chat/engine-signal-scope.ts";
import {
  createClackUserInputPrompt,
  type ChatUserInputPrompt,
} from "../utils/user-input-prompts.ts";
import { buildSessionPickerItems, type SessionPickerItem } from "../chat/session-picker-format.ts";
import { clackSessionPicker } from "../utils/clack-session-picker.ts";
import { diffDisplayNotice, resolveDiffDisplayToggle } from "../chat/diff-display.ts";
import { runBasicScheduleBrowser } from "../chat/basic-schedule-browser.ts";
import type { ScheduleBrowserPort } from "../chat/schedule-browser.ts";
import {
  backfillScheduledThreads,
  continueScheduledThread,
  createScheduleBrowserPort,
  parseScheduleAttempt,
} from "../../scheduler-host/schedule-history.ts";

import {
  CHAT_ENGINE_SURFACES,
  chatHostModeForSurface,
  createChatEngine,
  createRuntimeChatEngine,
  loadRuntime,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  resolveChatLlmSwitch,
  type ChatEngineSurface,
  type ConversationEngineInstance,
  type ThreadStoreInstance,
} from "../../runtime-host/engine-factory.ts";
import { runJsonTurn } from "../../runtime-host/json-turn.ts";
import { createRuntimeModelConfig } from "../../runtime-host/runtime-model-config.ts";
import { createChatGptCatalog } from "../../runtime-host/chatgpt-catalog.ts";

export {
  CHAT_ENGINE_SURFACES,
  chatHostModeForSurface,
  createChatEngine,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  resolveChatLlmSwitch,
  runJsonTurn,
};
export type { ChatEngineSurface };

const moduleExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

interface ChatCliScope {
  readonly env: NodeJS.ProcessEnv;
  dispose(): void;
}

interface ReplIo {
  readonly configuration?: ChatConfigurationControl;
  readonly operationLifecycle?: ChatOperationLifecycle;
  readonly workspace?: string;
  readonly allProjects?: boolean;
  readonly occupancyLabel?: (threadId: string) => string;
  readonly viewConversation?: (threadId: string) => string;
  readonly fastMode?: ChatFastModeControl;
  readonly beforeSend?: (signal?: AbortSignal) => Promise<void>;
  readonly connection?: ChatConnection;
  readonly input: Readable;
  readonly output: Writable;
  readonly confirm?: ChatConfirm;
  readonly userInputPrompt?: ChatUserInputPrompt;
  readonly signal?: AbortSignal;
  readonly resumeSession?: (threadId: string) => Promise<AgentSession>;
  readonly sessionPicker?: (items: readonly SessionPickerItem[]) => Promise<string | undefined>;
  readonly onActiveSessionChange?: (session: AgentSession) => void;
  readonly scheduleBrowser?: ScheduleBrowserPort;
}

function printChatJson(result: ChatCommandResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function shutdownSignalExitCode(signal: ChatEngineShutdownSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

function createChatCliScope(): ChatCliScope {
  const env = { ...process.env };
  try {
    const shim = installCurrentCliShim({ env });
    return { env, dispose: () => shim.dispose() };
  } catch (error) {
    log.warn(
      `无法锁定当前 Roll CLI，子任务将继续按 PATH 查找 roll：${error instanceof Error ? error.message : String(error)}`,
    );
    return { env, dispose: () => undefined };
  }
}

async function readReplLine(
  rl: ReadlineInterface,
  prompt: string,
  label: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  log.debug(`chat.repl input waiting · ${label}`);
  rl.resume();
  try {
    const line =
      signal === undefined ? await rl.question(prompt) : await rl.question(prompt, { signal });
    log.debug(`chat.repl input received · ${label} · chars=${String(line.length)}`);
    return line;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug(`chat.repl input closed · ${label} · ${message}`);
    return undefined;
  } finally {
    rl.pause();
  }
}

async function runChatOnboardingFlow(
  provider: string,
  model: string,
  options: RuntimeConfigOptions,
): Promise<boolean> {
  const specifier = new URL(`./setup.${moduleExtension}`, import.meta.url).href;
  const setupModule = (await import(specifier)) as typeof import("./setup.ts");
  return setupModule.runChatOnboarding({}, { ...options, provider, model });
}

export async function runServer(
  config: RollConfig,
  configContext?: RuntimeConfigContext,
  readBoundConfig?: () => RollConfig,
): Promise<void> {
  captureSessionLibraryBinding();
  const llmStatus = resolveChatLlmReadiness(config);
  if (!llmStatus.configured || !llmStatus.providerConfig) {
    log.error(llmStatus.message);
    process.exitCode = 1;
    return;
  }
  const providerConfig = llmStatus.providerConfig;
  const provider = llmStatus.provider;
  const modelName = llmStatus.model;

  const runtime = await loadRuntime();
  const {
    AttachmentStore,
    RuntimeClientRequestCoordinator,
    RuntimeService,
    RuntimeServer,
    createStdioConnection,
  } = runtime;
  let calls: ReturnType<typeof resolveChatLlmCalls>;
  try {
    calls = resolveChatLlmCalls(
      provider,
      modelName,
      providerConfig.apiKey,
      providerConfig.baseUrl,
      config.runtime.thinkingLevel,
      config.runtime.compaction.thinkingLevel,
      config.runtime.compaction.strategy === "summarize",
    );
  } catch (error) {
    if (!(error instanceof UnsupportedThinkingLevelError)) throw error;
    log.error(error.message);
    process.exitCode = 1;
    return;
  }
  const { model, providerOptions, structuredOutputProviderOptions, structuredOutputReasoning } =
    calls;
  const display = resolveReasoningPresentation(model, providerOptions);
  const store = createOwnedThreadStore(runtime, config.runtime.threadsDir, "runtime");
  const chatCliScope = createChatCliScope();
  let engine: ReturnType<typeof createRuntimeChatEngine> | undefined;
  let signalScope: ChatEngineSignalScope | undefined;
  try {
    backfillScheduledThreads(config, runtime, store);
    engine = createRuntimeChatEngine({
      runtime,
      config,
      model,
      store,
      surface: CHAT_ENGINE_SURFACES.server,
      ...(configContext === undefined ? {} : { configContext }),
      ...(display || readBoundConfig !== undefined ? { resolveReasoningPresentation } : {}),
      shellEnv: chatCliScope.env,
      ...(providerOptions ? { providerOptions } : {}),
      ...(structuredOutputProviderOptions ? { structuredOutputProviderOptions } : {}),
      ...(structuredOutputReasoning ? { structuredOutputReasoning } : {}),
    });
    const activeEngine = engine;
    const connection = createStdioConnection(process.stdin, process.stdout);
    const runtimeService = new RuntimeService(activeEngine, store, {
      serverVersion: "1.0",
      runtimeVersion: getCurrentVersion(),
      ...(display ? { providerReasoning: display.kind } : {}),
      ...(readBoundConfig === undefined
        ? {}
        : {
            modelConfig: createRuntimeModelConfig(
              config,
              { provider, model: modelName },
              readBoundConfig,
              activeEngine,
            ),
          }),
      attachmentStore: new AttachmentStore({
        dir: join(config.runtime.threadsDir, "attachments"),
      }),
    });
    const runtimeClientRequests = new RuntimeClientRequestCoordinator({
      onDiagnostic: (message) => {
        log.warn(message);
      },
    });
    const server = new RuntimeServer(activeEngine, connection, {
      runtimeService,
      runtimeClientRequests,
    });

    connection.onClose(() => {
      server
        .abortAll()
        .then(() => activeEngine.dispose())
        .catch(() => {})
        .finally(() => {
          signalScope?.dispose();
          chatCliScope.dispose();
          store.close();
          // Let pending HTTP/libuv handle cleanup drain before exiting the stdio host.
          process.exitCode ??= 0;
        });
    });
    signalScope = createChatEngineSignalScope({
      onSignal: (signal) => {
        process.exitCode = shutdownSignalExitCode(signal);
        connection.close();
      },
      onDisposeError: (error) => {
        log.warn(
          `roll runtime-server 关闭 Engine 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
    signalScope.setEngine(activeEngine);
  } catch (error) {
    signalScope?.dispose();
    await engine?.dispose().catch(() => {});
    chatCliScope.dispose();
    store.close();
    throw error;
  }

  log.info("roll runtime serve 已启动（stdio JSON-RPC，等待客户端连接）");
}

async function listSessions(
  config: RollConfig,
  asJson: boolean,
  workspace?: string,
): Promise<void> {
  const runtime = await loadRuntime();
  const result = withReadOnlyChatHistory(runtime, config, (store) => {
    const threads = store.listThreads({
      origin: "interactive",
      ...(workspace === undefined ? {} : { workspace }),
    });
    if (asJson) {
      console.log(
        JSON.stringify(
          threads.map((thread) => ({
            ...thread,
            messageCount: store.countMessages(thread.id),
            occupancy: store.inspectSessionOccupancy(thread.id),
          })),
          null,
          2,
        ),
      );
    } else if (threads.length === 0) {
      console.log(
        '当前项目暂无会话。用 `roll chat "<message>"` 开始一个；--all-projects 查看全部。',
      );
    } else {
      const table = new Table({
        head: ["Session ID", "标题", "项目", "状态", "消息", "更新时间"],
        style: { head: ["cyan"] },
      });
      for (const thread of threads) {
        table.push([
          thread.id,
          thread.title ?? "-",
          thread.workspace ?? "未分类",
          occupancyLabel(store, thread.id),
          String(store.countMessages(thread.id)),
          thread.updatedAt,
        ]);
      }
      console.log(table.toString());
    }
    return true;
  });
  if (result === undefined) console.log(asJson ? "[]" : "当前项目暂无会话。");
}

function occupancyLabel(store: ThreadStoreInstance, threadId: string): string {
  const occupancy = store.inspectSessionOccupancy(threadId);
  return occupancy.status === "occupied"
    ? `占用中 · ${occupancy.owner?.label ?? "其他客户端"}`
    : occupancy.status === "unknown"
      ? "占用状态未知"
      : "可继续";
}

export async function runRepl(
  session: AgentSession,
  store: ThreadStoreInstance,
  isNewSession: boolean,
  io: ReplIo = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const rl = createInterface({ input: io.input, output: io.output });
  rl.on("SIGINT", () => rl.close());
  const confirmFn: ChatConfirm =
    io.confirm ??
    (async (message, signal) => {
      log.debug("chat.repl input waiting · confirm");
      rl.pause();
      const approved = await clackConfirm(message, signal);
      log.debug(`chat.repl input received · confirm · approved=${String(approved)}`);
      return approved;
    });
  const userInputPromptSource =
    io.userInputPrompt ?? createClackUserInputPrompt({ input: io.input, output: io.output });
  const userInputPrompt: ChatUserInputPrompt = {
    async request(form, signal) {
      log.debug("chat.repl input waiting · user-input");
      rl.pause();
      const result = await userInputPromptSource.request(form, signal);
      log.debug(`chat.repl input received · user-input · status=${result.status}`);
      return result;
    },
  };
  let renderer = new ChatRenderer(
    confirmFn,
    session.getContextWindow(),
    io.signal,
    userInputPrompt,
  );
  let availableSkills = session.getSkillSummaries();
  session.setUserInputAvailable(true);
  log.info("进入多轮对话（输入 exit / quit 或 Ctrl-C 退出，/compact 手动压缩上下文）");

  let lastConnectionFailure: string | undefined;
  const reportConnectionFailure = () => {
    const snapshot = io.connection?.getSnapshot();
    const message =
      snapshot?.state === "failed" && snapshot.reportedInTurn !== true
        ? snapshot.message
        : undefined;
    if (message !== undefined && message !== lastConnectionFailure) log.warn(message);
    lastConnectionFailure = message;
  };
  const unsubscribeConnection = io.connection?.subscribe(reportConnectionFailure);
  reportConnectionFailure();
  io.connection?.start();
  const unsubscribeConfiguration = io.configuration?.subscribe((snapshot) =>
    log.info(snapshot.text),
  );
  let titled = !isNewSession;
  const initial = { id: session.id, isNew: isNewSession, submitted: false };
  try {
    while (true) {
      const answer = await readReplLine(rl, chalk.green("› "), "prompt", io.signal);
      if (answer === undefined) {
        break;
      }
      const input = answer.trim();
      if (input.length === 0) {
        continue;
      }
      if (input === "exit" || input === "quit") {
        break;
      }
      if (input === "/reconnect") {
        if (io.connection) {
          // Recovery never queues/replays user turns or tools.
          // The subscription reports the failed snapshot once, including explicit retries.
          io.connection.retry().catch(() => {});
        } else log.info("当前连接无需 ChatGPT 授权恢复。");
        continue;
      }
      if (input === "/fast" || input.startsWith("/fast ")) {
        const notice = await runFastModeCommand(input.slice("/fast".length), io.fastMode);
        if (notice !== undefined) {
          if (notice.tone === "warning") log.warn(notice.text);
          else log.info(notice.text);
        }
        continue;
      }
      if (input === "/status" || input === "/reload") {
        if (!io.configuration) log.info("当前入口没有可重新加载的配置来源");
        else if (input === "/status") log.info(io.configuration.snapshot().text);
        else {
          try {
            io.configuration.reload();
          } catch (error) {
            log.error(error instanceof Error ? error.message : String(error));
          }
        }
        continue;
      }
      if (input === "/view" || input.startsWith("/view ")) {
        try {
          log.info(io.viewConversation?.(input.slice(5).trim()) ?? "当前入口不支持只读查看");
        } catch (error) {
          log.error(error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      if (input === "/compact") {
        log.debug("chat.repl manual compact requested");
        try {
          io.operationLifecycle?.begin();
          try {
            for await (const event of session.compact("manual")) {
              await renderer.handle(event, session);
            }
          } finally {
            io.operationLifecycle?.end();
          }
        } catch (error) {
          log.error(error instanceof Error ? error.message : String(error));
        }
        log.debug("chat.repl manual compact completed");
        continue;
      }
      if (input === "/diff" || input.startsWith("/diff ")) {
        const next = resolveDiffDisplayToggle(input.slice("/diff".length), renderer.diffDisplay);
        renderer.setDiffDisplay(next);
        log.info(diffDisplayNotice(next));
        continue;
      }
      if (input === "/skills") {
        log.info(formatSkillList(availableSkills, (process.stdout.columns || 96) - 2));
        continue;
      }
      if (input === "/model" || input.startsWith("/model ")) {
        log.info("基础模式不支持 /model，请在全屏模式（roll chat）中使用");
        continue;
      }
      if (input === "/schedule") {
        if (io.scheduleBrowser === undefined) {
          log.info("当前入口不支持定时任务浏览");
          continue;
        }
        rl.pause();
        let next: AgentSession | undefined;
        try {
          next = await runBasicScheduleBrowser(io.scheduleBrowser, {
            input: io.input,
            output: io.output,
            ...(io.signal ? { signal: io.signal } : {}),
          });
        } catch (error) {
          log.error(`查看失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (next !== undefined) {
          const previous = session;
          session = next;
          io.onActiveSessionChange?.(session);
          previous.setUserInputAvailable(false);
          const settled = await previous
            .close()
            .then(() => true)
            .catch((error: unknown) => {
              log.warn(
                `原会话清理未完成：${error instanceof Error ? error.message : String(error)}`,
              );
              return false;
            });
          if (
            settled &&
            initial.isNew &&
            previous.id === initial.id &&
            !initial.submitted &&
            store.countMessages(previous.id) === 0
          ) {
            store.deleteThread(previous.id, { onlyIfEmpty: true });
          }
          session.setUserInputAvailable(true);
          const previousDiffDisplay = renderer.diffDisplay;
          renderer = new ChatRenderer(
            confirmFn,
            session.getContextWindow(),
            io.signal,
            userInputPrompt,
          );
          renderer.setDiffDisplay(previousDiffDisplay);
          availableSkills = session.getSkillSummaries();
          titled = true;
          log.info(`已基于执行快照创建讨论 ${session.id}；当前工作目录：${process.cwd()}`);
        }
        continue;
      }
      if (input === "/resume" || input === "/resume all") {
        if (io.resumeSession === undefined) {
          log.info("当前模式不支持会话切换");
          continue;
        }
        const items = buildSessionPickerItems(
          store.listThreads({
            origin: "interactive",
            ...(input === "/resume all" || io.allProjects || io.workspace === undefined
              ? {}
              : { workspace: io.workspace }),
          }),
          {
            currentSessionId: session.id,
            countMessages: (threadId) => store.countMessages(threadId),
            now: new Date(),
            ...(io.occupancyLabel ? { occupancyLabel: io.occupancyLabel } : {}),
          },
        );
        if (items.length === 0) {
          log.info("暂无其他会话");
          continue;
        }
        rl.pause();
        const targetId = await (io.sessionPicker ?? clackSessionPicker)(items);
        if (targetId === undefined) {
          continue;
        }
        let next: AgentSession;
        try {
          next = await io.resumeSession(targetId);
        } catch (error) {
          log.error(`切换失败：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const previous = session;
        previous.setUserInputAvailable(false);
        await previous.close();
        if (
          initial.isNew &&
          previous.id === initial.id &&
          !initial.submitted &&
          store.countMessages(previous.id) === 0
        ) {
          store.deleteThread(previous.id, { onlyIfEmpty: true });
        }
        session = next;
        session.setUserInputAvailable(true);
        const previousDiffDisplay = renderer.diffDisplay;
        renderer = new ChatRenderer(
          confirmFn,
          session.getContextWindow(),
          io.signal,
          userInputPrompt,
        );
        renderer.setDiffDisplay(previousDiffDisplay);
        availableSkills = session.getSkillSummaries();
        const record = store.getThread(session.id);
        titled = record?.title !== undefined;
        io.onActiveSessionChange?.(session);
        log.info(
          `已切换到会话 ${session.id}${record?.title === undefined ? "" : ` · ${record.title}`}`,
        );
        continue;
      }
      const skillInvocation = parseSkillInvocation(input, availableSkills);
      if (skillInvocation && skillInvocation.prompt.length === 0) {
        log.info("用法: /<skill-name> [/<skill-name> ...] 你的请求");
        continue;
      }
      if (!titled) {
        store.updateTitle(session.id, titleFromMessage(input));
        titled = true;
      }
      if (session.id === initial.id) {
        initial.submitted = true;
      }
      log.debug(`chat.repl send start · chars=${String(input.length)}`);
      try {
        io.operationLifecycle?.begin();
        try {
          await io.beforeSend?.(io.signal);
          for await (const event of session.send(input)) await renderer.handle(event, session);
        } finally {
          io.operationLifecycle?.end();
        }
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
      }
      log.debug("chat.repl send completed");
    }
  } finally {
    try {
      session.setUserInputAvailable(false);
    } finally {
      unsubscribeConnection?.();
      unsubscribeConfiguration?.();
      rl.close();
      if (
        initial.isNew &&
        session.id === initial.id &&
        !initial.submitted &&
        store.countMessages(session.id) === 0
      ) {
        store.deleteThread(session.id, { onlyIfEmpty: true });
      }
    }
  }
}

export default defineCommand({
  meta: {
    description: "会话式 AI 助手（多轮对话 + 自动工具调用）",
  },
  args: {
    message: { type: "positional", description: "起始消息", required: false },
    session: { type: "string", description: "继续已有会话的 session ID" },
    provider: { type: "string", description: "本次聊天模型提供商（chatgpt 为实验订阅通道）" },
    model: { type: "string", description: "本次聊天模型；ChatGPT 使用订阅目录的 slug" },
    account: { type: "string", description: "ChatGPT 订阅注册 ID（优先于配置）" },
    fast: {
      type: "boolean",
      description: "开启 ChatGPT Fast 模式（可能增加额度消耗）；--no-fast 关闭",
    },
    "from-run": { type: "string", description: "基于指定定时运行的快照开始普通对话" },
    attempt: { type: "string", description: "--from-run 的尝试序号（默认最新有关联的尝试）" },
    config: { type: "string", description: "明确指定配置文件" },
    "config-workspace": { type: "string", description: "配置内相对资源路径的绝对基准目录" },
    "all-projects": { type: "boolean", description: "查看或恢复所有项目的会话", default: false },
    view: { type: "string", description: "按 ID 只读查看会话，不取得可写占用" },
    last: { type: "boolean", description: "继续当前项目最近一个会话", default: false },
    list: { type: "boolean", description: "列出已有会话", default: false },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    server: {
      type: "boolean",
      description: "旧兼容入口：JSON-RPC over stdio（新宿主使用 `roll runtime serve --stdio`）",
      default: false,
    },
    "screen-mode": {
      type: "string",
      description: `交互界面模式（${CHAT_SCREEN_MODES.join("|")}）`,
    },
  },
  async run({ args }) {
    captureSessionLibraryBinding();
    const configOptions = {
      ...(args.config === undefined ? {} : { configPath: args.config }),
      ...(args["config-workspace"] === undefined
        ? {}
        : { configWorkspace: args["config-workspace"] }),
    };
    let binding = loadChatConfigBinding(configOptions);
    let config = binding.config;
    const workspace = resolveChatWorkspace();
    const applyLlmOverrides = (loaded: RollConfig): RollConfig => {
      const runtime = { ...loaded.runtime };
      if (args.provider !== undefined) {
        if (
          args.provider !== (runtime.provider ?? loaded.llm.defaultProvider) &&
          args.model === undefined
        ) {
          delete runtime.model;
        }
        runtime.provider = args.provider;
      }
      if (args.model !== undefined) runtime.model = args.model;
      if (args.account !== undefined) runtime.chatgptAccountId = args.account;
      if (args.fast !== undefined) runtime.fastMode = args.fast;
      return { ...loaded, runtime };
    };
    config = applyLlmOverrides(config);
    const fromRun = args["from-run"];
    let requestedAttempt: number | undefined;
    try {
      requestedAttempt = parseScheduleAttempt(args.attempt);
      if ([Boolean(args.session), args.last, Boolean(fromRun)].filter(Boolean).length > 1) {
        throw new Error("--session、--last、--from-run 不能同时使用");
      }
      if (requestedAttempt !== undefined && fromRun === undefined) {
        throw new Error("--attempt 只能与 --from-run 一起使用");
      }
      if (fromRun !== undefined && (args.list || args.server)) {
        throw new Error("--from-run 不能与 --list 或 --server 一起使用");
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }

    const screenModeRequest = resolveChatScreenModeRequest({
      configMode: config.chat.screenMode,
      ...(args["screen-mode"] !== undefined ? { cliValue: args["screen-mode"] } : {}),
      messagePresent: args.message !== undefined,
      json: args.json,
      server: args.server,
      list: args.list,
    });
    if (!screenModeRequest.ok) {
      log.error(screenModeRequest.error);
      process.exitCode = 1;
      return;
    }

    if (args.server) {
      await runServer(
        config,
        binding.context,
        binding.configPath === undefined ? undefined : () => applyLlmOverrides(binding.read()),
      );
      return;
    }

    if (args.list) {
      await listSessions(config, args.json, args["all-projects"] ? undefined : workspace);
      return;
    }
    if (args.view !== undefined) {
      const runtime = await loadRuntime();
      const viewed = withReadOnlyChatHistory(runtime, config, (store) =>
        args.json
          ? JSON.stringify(store.readSnapshot(args.view), null, 2)
          : readOnlyConversationText(store, args.view),
      );
      if (viewed === undefined) throw new Error("会话库不存在");
      console.log(viewed);
      return;
    }

    const canPrompt = process.stdin.isTTY === true && process.stderr.isTTY === true && !args.json;
    const onboardingOptions = binding.context ?? configOptions;
    if ((config.runtime.provider ?? config.llm.defaultProvider) !== "chatgpt") {
      const status = resolveChatLlmReadiness(config);
      if (
        !status.configured &&
        canPrompt &&
        (await runChatOnboardingFlow(status.provider, status.model, onboardingOptions))
      ) {
        binding = loadChatConfigBinding(onboardingOptions);
        config = applyLlmOverrides(binding.config);
      }
    }
    const presentationDecision = args.message
      ? undefined
      : resolveChatPresentation({
          mode: screenModeRequest.mode,
          source: screenModeRequest.source,
          capabilities: await detectChatTerminalCapabilities({
            stdinIsTty: process.stdin.isTTY === true,
            stdoutIsTty: process.stdout.isTTY === true,
            rawModeSupported: typeof process.stdin.setRawMode === "function",
            env: process.env,
          }),
        });
    if (presentationDecision !== undefined && !presentationDecision.ok) {
      log.error(presentationDecision.error);
      process.exitCode = 1;
      return;
    }
    if (presentationDecision?.warning) {
      log.warn(presentationDecision.warning);
    } else if (
      presentationDecision?.presentation === CHAT_PRESENTATIONS.inline &&
      presentationDecision.reason !== "requested"
    ) {
      log.debug(`chat 自动选择基础 REPL：${presentationDecision.reason}`);
    }
    const needsStartupModel =
      presentationDecision?.presentation === CHAT_PRESENTATIONS.inline &&
      (config.runtime.provider ?? config.llm.defaultProvider) === "chatgpt" &&
      config.runtime.model === undefined;
    if (needsStartupModel && !canPrompt) {
      log.error("基础模式需要指定 ChatGPT 模型：请使用 --model <slug>，或配置 runtime.model。");
      process.exitCode = 1;
      return;
    }
    const startupConfig = config;
    let selection: Awaited<ReturnType<typeof resolveInteractiveChatLlm>>;
    try {
      selection = await resolveInteractiveChatLlm(config, {
        deferConnection: !args.message && !args.json && !needsStartupModel,
        enableRecovery: !args.message && !args.json,
        ...(canPrompt
          ? {
              selectModel: async (models: ChatGptModels) => {
                if (models.length === 0) throw new Error("当前账号没有可用的 ChatGPT 订阅模型。");
                const selected = await select<string>({
                  message: "选择 ChatGPT 订阅模型",
                  options: models.map(({ slug, displayName }) => ({
                    value: slug,
                    label: displayName,
                    hint: slug,
                  })),
                });
                return isCancel(selected) ? undefined : selected;
              },
            }
          : {}),
      });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    const provider = selection.provider;
    const modelName = selection.modelName;
    config = {
      ...config,
      runtime: {
        ...config.runtime,
        provider,
        model: modelName,
        ...(selection.accountId ? { chatgptAccountId: selection.accountId } : {}),
      },
    };
    let subscriptionModels = selection.models ?? [];
    let subscriptionAccountId = selection.accountId ?? config.runtime.chatgptAccountId;
    let currentProvider = provider;
    let currentModel = modelName;
    let currentThinkingLevel = config.runtime.thinkingLevel;
    let currentFastMode = config.runtime.fastMode;
    const chatConnection =
      selection.connection ??
      new ChatGptConnection(
        {
          status: () => getChatGptAuthService().status(),
          models: (account, signal) => getChatGptAuthService().models(account, signal),
          getAccessToken: (account, signal) =>
            getChatGptAuthService().getAccessToken(account, signal),
        },
        subscriptionAccountId,
        subscriptionModels,
      );
    chatConnection.setEnabled(provider === "chatgpt");
    let activeSelection: EngineModelSwitch = selection;

    if (args.json && !args.message) {
      log.error('--json 模式需要消息：roll chat "<message>" --json');
      process.exitCode = 1;
      return;
    }

    const runtime = await loadRuntime();

    const {
      model,
      modelRecovery,
      providerOptions,
      structuredOutputProviderOptions,
      structuredOutputReasoning,
    } = selection;
    const store = createOwnedThreadStore(runtime, config.runtime.threadsDir);
    const modelCatalog = createChatGptCatalog(
      runtime,
      runtime.createDefaultModelCatalog(runtime.defaultModelCatalogCachePath()),
      () => chatConnection.models,
    );
    const catalogRefreshController = new AbortController();
    const surface = args.message
      ? args.json
        ? CHAT_ENGINE_SURFACES.json
        : CHAT_ENGINE_SURFACES.oneShot
      : presentationDecision?.presentation === CHAT_PRESENTATIONS.fullscreen
        ? CHAT_ENGINE_SURFACES.ink
        : CHAT_ENGINE_SURFACES.basicRepl;
    const chatCliScope = createChatCliScope();
    let engine: ConversationEngineInstance | undefined;
    let sessionForCleanup: AgentSession | undefined;
    let signalScope: ChatEngineSignalScope | undefined;
    let sessionPreparation: ReturnType<typeof createChatGptSessionPreparation> | undefined;
    let configuration: ReturnType<typeof createChatConfigurationControl> | undefined;
    try {
      backfillScheduledThreads(config, runtime, store);
      if (surface === CHAT_ENGINE_SURFACES.ink || surface === CHAT_ENGINE_SURFACES.basicRepl) {
        modelCatalog.refreshIfStale(catalogRefreshController.signal).then(
          (result) => {
            log.debug(`model catalog refresh: ${result}`);
          },
          (error: unknown) => {
            log.debug(`model catalog refresh failed: ${String(error)}`);
          },
        );
      }
      engine = createChatEngine({
        runtime,
        config,
        ...(binding.context === undefined ? {} : { configContext: binding.context }),
        resolveReasoningPresentation,
        model,
        store,
        surface,
        modelCatalog,
        shellEnv: chatCliScope.env,
        ...(modelRecovery ? { modelRecovery } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        ...(structuredOutputProviderOptions ? { structuredOutputProviderOptions } : {}),
        ...(structuredOutputReasoning ? { structuredOutputReasoning } : {}),
      });
      signalScope = createChatEngineSignalScope({
        onSignal: (signal) => {
          process.exitCode = shutdownSignalExitCode(signal);
        },
        onDisposeError: (error) => {
          log.warn(
            `roll chat 关闭 Engine 失败：${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
      signalScope.setEngine(engine);
      const chatEngine = engine;
      const fastMode = createChatFastModeControl({
        guard: () => configuration?.guard() ?? (() => {}),
        isAvailable: () => currentProvider === "chatgpt",
        getEnabled: () => currentProvider === "chatgpt" && currentFastMode,
        prepareEnable: async () => {
          configuration?.assertReady();
          if (currentProvider !== "chatgpt") {
            throw new Error("Fast 模式仅适用于 ChatGPT 订阅模型。");
          }
          await chatConnection.ensure();
        },
        apply: (enabled) => {
          configuration?.assertReady();
          if (currentProvider !== "chatgpt") {
            if (enabled) throw new Error("Fast 模式仅适用于 ChatGPT 订阅模型。");
            currentFastMode = false;
            return;
          }
          assertChatGptFastModeSupported(
            enabled,
            chatConnection.models.find(({ slug }) => slug === currentModel),
          );
          // The controller already invalidated older requests; preserve calibration on no-op sets.
          if (enabled === currentFastMode) return;
          const nextSelection = {
            ...activeSelection,
            providerOptions: withChatGptFastMode(activeSelection.providerOptions, enabled),
            structuredOutputProviderOptions: withChatGptFastMode(
              activeSelection.structuredOutputProviderOptions,
              enabled,
            ),
          };
          // Engine switching updates live sessions, Sampling and compaction together.
          chatEngine.switchModel(nextSelection);
          activeSelection = nextSelection;
          currentFastMode = enabled;
        },
      });
      sessionPreparation = createChatGptSessionPreparation({
        connection: chatConnection,
        engine: chatEngine,
        getSession: () => sessionForCleanup,
        getSelection: () => activeSelection,
        ...(config.runtime.contextWindow !== undefined
          ? { contextWindowOverride: config.runtime.contextWindow }
          : {}),
      });
      configuration = createChatConfigurationControl({
        runtime,
        initial: { provider, model: modelName },
        ...(resolveReasoningPresentation(model, providerOptions) === undefined
          ? {}
          : { initialReasoning: resolveReasoningPresentation(model, providerOptions)!.kind }),
        startupConfig,
        source: binding.configPath ?? "内置默认配置（没有可重新加载的文件）",
        workspace,
        ...(binding.configPath === undefined
          ? {}
          : { read: () => applyLlmOverrides(binding.read()) }),
        getThinkingLevel: () => currentThinkingLevel,
        async apply(latest, signal) {
          const prepared = await prepareInteractiveChatReload(
            latest,
            chatConnection,
            subscriptionAccountId,
            undefined,
            signal,
          );
          const next = prepared.selection;
          signal?.throwIfAborted();
          if (
            prepared.accountId !== undefined &&
            chatConnection.accountId !== undefined &&
            prepared.accountId !== chatConnection.accountId
          ) {
            throw new Error("ChatGPT 账号已变化，请重新连接");
          }
          chatEngine.switchModel(next);
          config = latest;
          activeSelection = next;
          currentProvider = next.provider;
          currentModel = next.modelName;
          currentThinkingLevel = latest.runtime.thinkingLevel;
          currentFastMode = latest.runtime.fastMode;
          if (prepared.models !== undefined) {
            subscriptionModels = prepared.models;
            subscriptionAccountId = prepared.accountId;
            chatConnection.updateCatalog(prepared.models, prepared.accountId);
          }
          chatConnection.setEnabled(currentProvider === "chatgpt");
          sessionPreparation?.synchronize();
          const reasoning = resolveReasoningPresentation(
            activeSelection.model,
            activeSelection.providerOptions,
          );
          return {
            status: "applied",
            model: { provider: currentProvider, model: currentModel },
            ...(reasoning ? { reasoning: reasoning.kind } : {}),
          };
        },
      });
      const viewConversation = (threadId: string) => {
        if (!threadId) throw new Error("用法: /view <session-id>");
        const text = withReadOnlyChatHistory(runtime, config, (readOnly) =>
          readOnlyConversationText(readOnly, threadId),
        );
        if (text === undefined) throw new Error("会话库不存在");
        return text;
      };
      const scheduleBrowser = createScheduleBrowserPort({ config, runtime, engine: chatEngine });
      const resumeSession = async (threadId: string): Promise<AgentSession> => {
        if (store.getThread(threadId)?.origin.kind === "scheduled") {
          const next = await continueScheduledThread(
            { config, runtime, engine: chatEngine },
            threadId,
          );
          log.info(
            `已基于执行快照创建讨论 ${next.id}；原执行会话 ${threadId} 保留；当前工作目录：${process.cwd()}`,
          );
          return next;
        }
        return chatEngine.resumeSession(threadId);
      };
      let session: AgentSession;
      if (fromRun !== undefined) {
        const detail = await scheduleBrowser.inspect(fromRun, requestedAttempt);
        session = await scheduleBrowser.continueRun(fromRun, detail.attempt);
        log.info(
          `已创建讨论 ${session.id}；原任务目录：${detail.cwd}；当前工作目录：${process.cwd()}`,
        );
      } else if (args.session) {
        session = await resumeSession(args.session);
      } else if (args.last) {
        const latest = store.listThreads({
          origin: "interactive",
          ...(args["all-projects"] ? {} : { workspace }),
        })[0];
        if (!latest) {
          log.error('当前项目暂无可继续的会话，先用 `roll chat "<message>"` 开始一个');
          process.exitCode = 1;
          return;
        }
        session = await engine.resumeSession(latest.id);
      } else {
        session = await engine.createSession(
          args.message ? { title: titleFromMessage(args.message) } : {},
        );
      }
      sessionForCleanup = session;
      sessionPreparation.synchronize();

      if (args.json && args.message) {
        const result = await runJsonTurn(session, args.message);
        printChatJson(result);
        if (result.status !== "completed") {
          process.exitCode = 1;
        }
        return;
      }

      if (presentationDecision?.presentation !== CHAT_PRESENTATIONS.fullscreen) {
        log.info(`会话 ${session.id}`);
      }
      if (config.runtime.compaction.enabled && session.getContextWindow() === undefined) {
        log.warn(
          `未知模型 "${provider}/${modelName}" 的 context window，阈值自动压缩不可用。模型目录会每天自动刷新；也可在 roll.config.yaml 设置 runtime.context-window`,
        );
      }
      if (args.message) {
        const renderer = new ChatRenderer(
          clackConfirm,
          session.getContextWindow(),
          signalScope.signal,
        );
        for await (const event of session.send(args.message)) {
          await renderer.handle(event, session);
        }
      } else {
        const isNewSession = !args.session && !args.last && fromRun === undefined;
        const summary = await engine.getContextSummary();
        const banner: BannerInfo = {
          version: getCurrentVersion(),
          model: currentModel,
          agentCount: summary.agentCount,
          skillCount: summary.skillCount,
          ...(summary.instructionsPath !== undefined
            ? { instructionsFile: basename(summary.instructionsPath) }
            : {}),
        };
        let usedInk = false;
        if (presentationDecision?.presentation === CHAT_PRESENTATIONS.fullscreen) {
          try {
            const inkReplSpecifier = new URL(
              `../chat/ink/run-ink-repl.${moduleExtension}`,
              import.meta.url,
            ).href;
            const { runInkRepl } = (await import(
              inkReplSpecifier
            )) as typeof import("../chat/ink/run-ink-repl.ts");
            await runInkRepl(session, store, isNewSession, {
              fastMode,
              configuration,
              operationLifecycle: configuration.lifecycle,
              workspace,
              allProjects: args["all-projects"],
              occupancyLabel: (id) => occupancyLabel(store, id),
              viewConversation,
              model: currentModel,
              connection: chatConnection,
              beforeSend: sessionPreparation.prepare,
              banner,
              initialThinkingLevel: config.runtime.thinkingLevel,
              initialThinkingDisplay: config.chat.thinkingDisplay,
              onStarted: () => {
                usedInk = true;
              },
              signal: signalScope.signal,
              getThinkingLevels: () =>
                currentProvider === "chatgpt"
                  ? chatGptThinkingLevels(
                      chatConnection.models.find(({ slug }) => slug === currentModel),
                    )
                  : legacyThinkingLevels,
              onThinkingChange: (level) => {
                const nextOptions =
                  currentProvider === "chatgpt"
                    ? withChatGptFastMode(
                        chatGptThinkingOptions(
                          level,
                          chatConnection.models.find(({ slug }) => slug === currentModel),
                        ),
                        currentFastMode,
                      )
                    : thinkingProviderOptions(currentProvider, currentModel, level);
                configuration?.assertReady();
                session.setProviderOptions(nextOptions);
                activeSelection = { ...activeSelection, providerOptions: nextOptions ?? {} };
                currentThinkingLevel = level;
                configuration?.adoptActive(
                  { provider: currentProvider, model: currentModel },
                  resolveReasoningPresentation(activeSelection.model, nextOptions)?.kind,
                );
              },
              resumeSession,
              scheduleBrowser,
              onActiveSessionChange: (next) => {
                session = next;
                sessionForCleanup = next;
              },
              modelSwitching: {
                loadItems: async (current) => {
                  try {
                    const choices = await loadAuthenticatedChatGptModels(
                      getChatGptAuthService(),
                      subscriptionAccountId,
                    );
                    subscriptionModels = choices.models;
                    subscriptionAccountId = choices.accountId;
                    chatConnection.updateCatalog(choices.models, choices.accountId);
                  } catch (error) {
                    log.warn(error instanceof Error ? error.message : String(error));
                  }
                  return chatModelPickerItems(config, subscriptionModels, current);
                },
                getThinkingLevels: async (input) => {
                  const selected = findLlmModelChoice(
                    [...listLlmModelChoices(config), ...chatGptModelChoices(subscriptionModels)],
                    input,
                  );
                  if (selected?.provider !== "chatgpt" && !input.startsWith("chatgpt/")) {
                    return legacyThinkingLevels;
                  }
                  const choices = await loadAuthenticatedChatGptModels(
                    getChatGptAuthService(),
                    subscriptionAccountId,
                  );
                  subscriptionModels = choices.models;
                  subscriptionAccountId = choices.accountId;
                  chatConnection.updateCatalog(choices.models, choices.accountId);
                  const model = subscriptionModels.find(
                    ({ slug }) => `chatgpt/${slug}` === input || slug === selected?.model,
                  );
                  if (!model) throw new Error(`当前账号不提供模型 "${input}"`);
                  return chatGptThinkingLevels(model);
                },
                switchTo: async (input, selectedEffort) => {
                  const assertCurrent = configuration?.guard();
                  if (input.startsWith("chatgpt/") && subscriptionModels.length === 0) {
                    const choices = await loadAuthenticatedChatGptModels(
                      getChatGptAuthService(),
                      subscriptionAccountId,
                    );
                    subscriptionModels = choices.models;
                    subscriptionAccountId = choices.accountId;
                    chatConnection.updateCatalog(choices.models, choices.accountId);
                  }
                  const choice = findLlmModelChoice(
                    [...listLlmModelChoices(config), ...chatGptModelChoices(subscriptionModels)],
                    input,
                  );
                  if (!choice) {
                    throw new Error(`未知模型 "${input}"，输入 /model 查看可选项`);
                  }
                  return resolveAndSwitchChatModel({
                    resolve: () =>
                      resolveInteractiveChatSwitch(
                        { ...config, runtime: { ...config.runtime, fastMode: currentFastMode } },
                        choice,
                        selectedEffort ?? currentThinkingLevel,
                        subscriptionAccountId,
                        undefined,
                        chatConnection,
                      ),
                    getFastMode: () => currentFastMode,
                    commit: (nextSelection) => {
                      assertCurrent?.();
                      const resolution = chatEngine.switchModel(nextSelection);
                      activeSelection = nextSelection;
                      currentProvider = choice.provider;
                      chatConnection.setEnabled(choice.provider === "chatgpt");
                      currentModel = choice.model;
                      currentThinkingLevel = selectedEffort ?? currentThinkingLevel;
                      configuration?.adoptActive(
                        { provider: currentProvider, model: currentModel },
                        resolveReasoningPresentation(
                          nextSelection.model,
                          nextSelection.providerOptions,
                        )?.kind,
                      );
                      return {
                        thinkingLevel: currentThinkingLevel,
                        id: choice.id,
                        model: choice.model,
                        contextWindow: resolution?.window,
                        ...(resolution ? { contextWindowSource: resolution.source } : {}),
                      };
                    },
                  });
                },
                setAsDefault: async (id) => {
                  const choice = findLlmModelChoice(
                    [...listLlmModelChoices(config), ...chatGptModelChoices(subscriptionModels)],
                    id,
                  );
                  if (!choice) {
                    throw new Error(`未知模型 "${id}"`);
                  }
                  const written = writeDefaultLlm(
                    {
                      ...choice,
                      thinkingLevel: currentThinkingLevel,
                      ...(subscriptionAccountId ? { chatgptAccountId: subscriptionAccountId } : {}),
                    },
                    binding.configPath === undefined ? {} : { configPath: binding.configPath },
                  );
                  return `已将默认 LLM 设为 ${choice.id}（写入 ${written.configPath}）`;
                },
              } satisfies ChatModelSwitching,
            });
          } catch (inkError) {
            if (usedInk) {
              throw inkError;
            }
            log.info(`会话 ${session.id}`);
            log.warn(
              `Ink TUI 不可用，回退到基础多轮模式：${inkError instanceof Error ? inkError.message : String(inkError)}`,
            );
          }
        }
        if (!usedInk) {
          process.stderr.write(
            `${renderBannerText(buildBannerLines(banner, process.stdout.columns || 80))}\n`,
          );
          await runRepl(session, store, isNewSession, {
            fastMode,
            configuration,
            operationLifecycle: configuration.lifecycle,
            workspace,
            allProjects: args["all-projects"],
            occupancyLabel: (id) => occupancyLabel(store, id),
            viewConversation,
            input: process.stdin,
            output: process.stdout,
            connection: chatConnection,
            beforeSend: sessionPreparation.prepare,
            signal: signalScope.signal,
            resumeSession,
            scheduleBrowser,
            onActiveSessionChange: (next) => {
              session = next;
              sessionForCleanup = next;
            },
          });
        }
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      if (signalScope?.receivedSignal === undefined) {
        process.exitCode = 1;
      }
    } finally {
      configuration?.close();
      sessionPreparation?.dispose();
      chatConnection.dispose();
      catalogRefreshController.abort();
      signalScope?.dispose();
      try {
        await sessionForCleanup?.close();
      } finally {
        try {
          await engine?.dispose();
        } finally {
          try {
            store.close();
          } finally {
            chatCliScope.dispose();
          }
        }
      }
    }
  },
});
