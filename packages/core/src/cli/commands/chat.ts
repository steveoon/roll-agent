import { basename, join } from "node:path";
import { defineCommand } from "citty";
import type { AgentSession } from "@roll-agent/runtime";
import { loadConfig } from "../../config/loader.ts";
import { thinkingProviderOptions } from "../../llm/providers.ts";
import { findLlmModelChoice, listLlmModelChoices } from "../../llm/model-choices.ts";
import { writeDefaultLlm } from "../../config/default-llm-writer.ts";
import { buildModelPickerItems } from "../chat/model-picker-format.ts";
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
  loadRuntime,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  resolveChatLlmSwitch,
  type ChatEngineSurface,
  type ConversationEngineInstance,
  type ThreadStoreInstance,
} from "../../runtime-host/engine-factory.ts";
import { runJsonTurn } from "../../runtime-host/json-turn.ts";

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

async function runChatOnboardingFlow(provider: string, model: string): Promise<boolean> {
  const specifier = new URL(`./setup.${moduleExtension}`, import.meta.url).href;
  const setupModule = (await import(specifier)) as typeof import("./setup.ts");
  return setupModule.runChatOnboarding({}, { provider, model });
}

export async function runServer(config: RollConfig): Promise<void> {
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
    ThreadStore,
    RuntimeServer,
    createStdioConnection,
  } = runtime;
  const { model, providerOptions, structuredOutputProviderOptions, structuredOutputReasoning } =
    resolveChatLlmCalls(
      provider,
      modelName,
      providerConfig.apiKey,
      providerConfig.baseUrl,
      config.runtime.thinkingLevel,
      config.runtime.compaction.thinkingLevel,
      config.runtime.compaction.strategy === "summarize",
    );
  const store = new ThreadStore(config.runtime.threadsDir);
  const chatCliScope = createChatCliScope();
  let engine: ConversationEngineInstance | undefined;
  let signalScope: ChatEngineSignalScope | undefined;
  try {
    backfillScheduledThreads(config, runtime, store);
    engine = createChatEngine({
      runtime,
      config,
      model,
      store,
      surface: CHAT_ENGINE_SURFACES.server,
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
          process.exit(process.exitCode ?? 0);
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

async function listSessions(config: RollConfig, asJson: boolean): Promise<void> {
  const runtime = await loadRuntime();
  const { ThreadStore } = runtime;
  const store = new ThreadStore(config.runtime.threadsDir);
  try {
    backfillScheduledThreads(config, runtime, store);
    const threads = store.listThreads({ origin: "interactive" });
    if (asJson) {
      const data = threads.map((thread) => ({
        ...thread,
        messageCount: store.countMessages(thread.id),
      }));
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (threads.length === 0) {
      console.log('暂无会话。用 `roll chat "<message>"` 开始一个。');
      return;
    }
    const table = new Table({
      head: ["Session ID", "标题", "消息", "更新时间"],
      style: { head: ["cyan"] },
    });
    for (const thread of threads) {
      table.push([
        thread.id,
        thread.title ?? "-",
        String(store.countMessages(thread.id)),
        thread.updatedAt,
      ]);
    }
    console.log(table.toString());
  } finally {
    store.close();
  }
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
      if (input === "/compact") {
        log.debug("chat.repl manual compact requested");
        for await (const event of session.compact("manual")) {
          await renderer.handle(event, session);
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
          await previous.close().catch((error: unknown) => {
            log.warn(`原会话清理未完成：${error instanceof Error ? error.message : String(error)}`);
          });
          if (
            initial.isNew &&
            previous.id === initial.id &&
            !initial.submitted &&
            store.countMessages(previous.id) === 0
          ) {
            store.deleteThread(previous.id);
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
      if (input === "/resume") {
        if (io.resumeSession === undefined) {
          log.info("当前模式不支持会话切换");
          continue;
        }
        const items = buildSessionPickerItems(store.listThreads({ origin: "interactive" }), {
          currentSessionId: session.id,
          countMessages: (threadId) => store.countMessages(threadId),
          now: new Date(),
        });
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
          store.deleteThread(previous.id);
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
      for await (const event of session.send(input)) {
        await renderer.handle(event, session);
      }
      log.debug("chat.repl send completed");
    }
  } finally {
    try {
      session.setUserInputAvailable(false);
    } finally {
      rl.close();
      if (
        initial.isNew &&
        session.id === initial.id &&
        !initial.submitted &&
        store.countMessages(session.id) === 0
      ) {
        store.deleteThread(session.id);
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
    "from-run": { type: "string", description: "基于指定定时运行的快照开始普通对话" },
    attempt: { type: "string", description: "--from-run 的尝试序号（默认最新有关联的尝试）" },
    last: { type: "boolean", description: "继续最近一个会话", default: false },
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
    let { config } = loadConfig();
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
      await runServer(config);
      return;
    }

    if (args.list) {
      await listSessions(config, args.json);
      return;
    }

    let llmStatus = resolveChatLlmReadiness(config);
    if (!llmStatus.configured) {
      const canPrompt = process.stdin.isTTY === true && process.stderr.isTTY === true && !args.json;
      if (canPrompt && (await runChatOnboardingFlow(llmStatus.provider, llmStatus.model))) {
        config = loadConfig().config;
        llmStatus = resolveChatLlmReadiness(config);
      }
    }
    if (!llmStatus.configured || !llmStatus.providerConfig) {
      log.error(llmStatus.message);
      process.exitCode = 1;
      return;
    }
    const providerConfig = llmStatus.providerConfig;
    const provider = llmStatus.provider;
    const modelName = llmStatus.model;
    let currentProvider = provider;
    let currentModel = modelName;
    let currentThinkingLevel = config.runtime.thinkingLevel;

    if (args.json && !args.message) {
      log.error('--json 模式需要消息：roll chat "<message>" --json');
      process.exitCode = 1;
      return;
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

    const runtime = await loadRuntime();
    const { ThreadStore } = runtime;
    const { model, providerOptions, structuredOutputProviderOptions, structuredOutputReasoning } =
      resolveChatLlmCalls(
        provider,
        modelName,
        providerConfig.apiKey,
        providerConfig.baseUrl,
        config.runtime.thinkingLevel,
        config.runtime.compaction.thinkingLevel,
        config.runtime.compaction.strategy === "summarize",
      );
    const store = new ThreadStore(config.runtime.threadsDir);
    const modelCatalog = runtime.createDefaultModelCatalog(runtime.defaultModelCatalogCachePath());
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
    try {
      backfillScheduledThreads(config, runtime, store);
      if (surface === CHAT_ENGINE_SURFACES.ink || surface === CHAT_ENGINE_SURFACES.basicRepl) {
        modelCatalog.refreshIfStale().then(
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
        model,
        store,
        surface,
        modelCatalog,
        shellEnv: chatCliScope.env,
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
        const latest = store.listThreads({ origin: "interactive" })[0];
        if (!latest) {
          log.error('暂无可继续的会话，先用 `roll chat "<message>"` 开始一个');
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
          model: modelName,
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
              model: modelName,
              banner,
              initialThinkingLevel: config.runtime.thinkingLevel,
              initialThinkingDisplay: config.chat.thinkingDisplay,
              onStarted: () => {
                usedInk = true;
              },
              signal: signalScope.signal,
              onThinkingChange: (level) => {
                currentThinkingLevel = level;
                session.setProviderOptions(
                  thinkingProviderOptions(currentProvider, currentModel, level),
                );
              },
              resumeSession,
              scheduleBrowser,
              onActiveSessionChange: (next) => {
                session = next;
                sessionForCleanup = next;
              },
              modelSwitching: {
                loadItems: (current) => buildModelPickerItems(listLlmModelChoices(config), current),
                switchTo: async (input) => {
                  const choice = findLlmModelChoice(listLlmModelChoices(config), input);
                  if (!choice) {
                    throw new Error(`未知模型 "${input}"，输入 /model 查看可选项`);
                  }
                  const resolution = chatEngine.switchModel(
                    resolveChatLlmSwitch(config, choice, currentThinkingLevel),
                  );
                  currentProvider = choice.provider;
                  currentModel = choice.model;
                  return {
                    id: choice.id,
                    model: choice.model,
                    contextWindow: resolution?.window,
                    ...(resolution ? { contextWindowSource: resolution.source } : {}),
                  };
                },
                setAsDefault: async (id) => {
                  const choice = findLlmModelChoice(listLlmModelChoices(config), id);
                  if (!choice) {
                    throw new Error(`未知模型 "${id}"`);
                  }
                  const written = writeDefaultLlm(choice);
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
            input: process.stdin,
            output: process.stdout,
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
