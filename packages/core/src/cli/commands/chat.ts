import { defineCommand } from "citty";
import type { AgentSession } from "@roll-agent/runtime";
import { loadConfig } from "../../config/loader.ts";
import { resolveLLMCall, thinkingProviderOptions } from "../../llm/providers.ts";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import chalk from "chalk";
import Table from "cli-table3";
import { isDebugLogEnabled, log } from "../utils/output.ts";
import { ChatRenderer, clackConfirm, type ChatConfirm } from "../utils/chat-renderer.ts";
import type {
  ChatCommandResult,
  ChatCompactionSummary,
  ChatPendingAction,
  ChatStepSummary,
  ChatStepUsage,
  ChatTokenUsage,
} from "../../types/chat.ts";
import type { RollConfig } from "../../config/schema.ts";
import { titleFromMessage } from "../chat/title.ts";
import { buildBannerLines, renderBannerText, type BannerInfo } from "../chat/banner.ts";
import { getCurrentVersion } from "../utils/update-checker.ts";
import {
  buildSkillInvocationPrompt,
  formatSkillList,
  parseSkillInvocation,
} from "../chat/ink/commands.ts";

type RuntimeModule = typeof import("@roll-agent/runtime");

const moduleExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function createToolPolicy(runtime: RuntimeModule, config: RollConfig) {
  return new runtime.ConfigurableToolPolicy({
    defaultMode: config.runtime.approval.default,
    overrides: config.runtime.approval.overrides,
  });
}

type ThreadStoreInstance = InstanceType<RuntimeModule["ThreadStore"]>;

interface ReplIo {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly confirm?: ChatConfirm;
}

function printChatJson(result: ChatCommandResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function reportAgentBootstrapIssue(issue: {
  readonly agentName: string;
  readonly message: string;
}): void {
  log.warn(`Agent "${issue.agentName}" 启动失败：${issue.message}`);
}

function reportSkillLibraryIssue(message: string): void {
  log.warn(`skill 目录加载警告：${message}`);
}

function resolveSkillSendText(session: AgentSession, message: string): string {
  const invocation = parseSkillInvocation(message, session.getSkillSummaries());
  return invocation && invocation.prompt.length > 0
    ? buildSkillInvocationPrompt(invocation)
    : message;
}

async function readReplLine(
  rl: ReadlineInterface,
  prompt: string,
  label: string,
): Promise<string | undefined> {
  log.debug(`chat.repl input waiting · ${label}`);
  rl.resume();
  try {
    const line = await rl.question(prompt);
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

async function loadRuntime(): Promise<RuntimeModule> {
  return import("@roll-agent/runtime");
}

async function runServer(config: RollConfig): Promise<void> {
  const provider = config.runtime.provider ?? config.llm.defaultProvider;
  const modelName = config.runtime.model ?? config.llm.defaultModel;
  const providerConfig = config.llm.providers[provider];
  if (!providerConfig) {
    log.error(`LLM provider "${provider}" 未配置。请检查 roll.config.yaml`);
    process.exitCode = 1;
    return;
  }

  const runtime = await loadRuntime();
  const { ConversationEngine, ThreadStore, RuntimeServer, createStdioConnection } = runtime;
  const { model, providerOptions } = resolveLLMCall(
    provider,
    modelName,
    providerConfig.apiKey,
    "chat",
    providerConfig.baseUrl,
    config.runtime.thinkingLevel,
  );
  const store = new ThreadStore(config.runtime.threadsDir);
  const engine = new ConversationEngine({
    config,
    model,
    store,
    policy: createToolPolicy(runtime, config),
    maxSteps: config.runtime.maxSteps,
    ...(providerOptions ? { providerOptions } : {}),
    debugEvents: isDebugLogEnabled(),
    onAgentBootstrapIssue: reportAgentBootstrapIssue,
    onSkillLibraryIssue: reportSkillLibraryIssue,
  });
  const connection = createStdioConnection(process.stdin, process.stdout);
  const server = new RuntimeServer(engine, connection);

  connection.onClose(() => {
    server.abortAll();
    engine
      .dispose()
      .catch(() => {})
      .finally(() => {
        store.close();
        process.exit(0);
      });
  });

  log.info("roll runtime-server 已启动（stdio JSON-RPC，等待客户端连接）");
}

async function listSessions(config: RollConfig, asJson: boolean): Promise<void> {
  const { ThreadStore } = await loadRuntime();
  const store = new ThreadStore(config.runtime.threadsDir);
  try {
    const threads = store.listThreads();
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

export async function runJsonTurn(
  session: AgentSession,
  message: string,
): Promise<ChatCommandResult> {
  const steps: ChatStepSummary[] = [];
  const stepUsages: ChatStepUsage[] = [];
  const compactions: ChatCompactionSummary[] = [];
  const pendingActions: ChatPendingAction[] = [];
  let output = "";
  let failure: string | undefined;
  let totalUsage: ChatTokenUsage | undefined;
  let sessionUsage: ChatTokenUsage | undefined;
  let contextInputTokens: number | undefined;

  for await (const event of session.send(message)) {
    switch (event.type) {
      case "text-delta":
        output += event.delta;
        break;
      case "tool-call":
        steps.push({
          summary: `${event.agentName}.${event.toolName}`,
          agentName: event.agentName,
          toolName: event.toolName,
        });
        break;
      case "confirmation-required":
        pendingActions.push({
          summary: `${event.agentName}.${event.toolName}`,
          agentName: event.agentName,
          toolName: event.toolName,
        });
        session.reject(event.approvalId, "json 模式不支持交互确认");
        break;
      case "step-finish":
        stepUsages.push({
          finishReason: event.finishReason,
          ...(event.usage ? { usage: event.usage } : {}),
        });
        break;
      case "message-finish":
        totalUsage = event.totalUsage;
        sessionUsage = event.sessionUsage;
        contextInputTokens = event.contextInputTokens;
        break;
      case "context-compacted":
        compactions.push({
          reason: event.reason,
          strategy: event.strategy,
          removed: event.removed,
          kept: event.kept,
          ...(event.truncatedTools !== undefined ? { truncatedTools: event.truncatedTools } : {}),
          ...(event.beforeInputTokens !== undefined
            ? { beforeInputTokens: event.beforeInputTokens }
            : {}),
        });
        break;
      case "error":
        failure = event.message;
        break;
      default:
        break;
    }
  }

  const contextWindow = session.getContextWindow();

  if (failure !== undefined) {
    return { status: "failed", stage: "execute", message: failure, sessionId: session.id };
  }
  if (pendingActions.length > 0) {
    return {
      status: "needs_confirmation",
      sessionId: session.id,
      message: "存在需要确认的工具调用，请在交互模式下执行或显式批准",
      pendingActions,
    };
  }
  return {
    status: "completed",
    sessionId: session.id,
    output,
    steps,
    ...(stepUsages.length > 0 ? { stepUsages } : {}),
    ...(totalUsage ? { totalUsage } : {}),
    ...(sessionUsage ? { sessionUsage } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextInputTokens !== undefined ? { contextInputTokens } : {}),
    ...(compactions.length > 0 ? { compactions } : {}),
  };
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
    (async (message) => {
      log.debug("chat.repl input waiting · confirm");
      rl.pause();
      const approved = await clackConfirm(message);
      log.debug(`chat.repl input received · confirm · approved=${String(approved)}`);
      return approved;
    });
  const renderer = new ChatRenderer(confirmFn, session.getContextWindow());
  const availableSkills = session.getSkillSummaries();
  log.info("进入多轮对话（输入 exit / quit 或 Ctrl-C 退出，/compact 手动压缩上下文）");

  let titled = !isNewSession;
  let submitted = false;
  try {
    while (true) {
      const answer = await readReplLine(rl, chalk.green("› "), "prompt");
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
      if (input === "/skills") {
        log.info(formatSkillList(availableSkills, (process.stdout.columns || 96) - 2));
        continue;
      }
      const skillInvocation = parseSkillInvocation(input, availableSkills);
      if (skillInvocation && skillInvocation.prompt.length === 0) {
        log.info("用法: /<skill-name> [/<skill-name> ...] 你的请求");
        continue;
      }
      const sendInput = skillInvocation ? buildSkillInvocationPrompt(skillInvocation) : input;
      if (!titled) {
        store.updateTitle(session.id, titleFromMessage(input));
        titled = true;
      }
      submitted = true;
      log.debug(`chat.repl send start · chars=${String(input.length)}`);
      for await (const event of session.send(sendInput)) {
        await renderer.handle(event, session);
      }
      log.debug("chat.repl send completed");
    }
  } finally {
    rl.close();
    if (isNewSession && !submitted && store.countMessages(session.id) === 0) {
      store.deleteThread(session.id);
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
    last: { type: "boolean", description: "继续最近一个会话", default: false },
    list: { type: "boolean", description: "列出已有会话", default: false },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    server: {
      type: "boolean",
      description: "以 JSON-RPC daemon 模式运行（stdio，供 GUI/前端接入）",
      default: false,
    },
  },
  async run({ args }) {
    const { config } = loadConfig();

    if (args.server) {
      await runServer(config);
      return;
    }

    if (args.list) {
      await listSessions(config, args.json);
      return;
    }

    const provider = config.runtime.provider ?? config.llm.defaultProvider;
    const modelName = config.runtime.model ?? config.llm.defaultModel;
    const providerConfig = config.llm.providers[provider];
    if (!providerConfig) {
      log.error(`LLM provider "${provider}" 未配置。请检查 roll.config.yaml`);
      process.exitCode = 1;
      return;
    }

    if (args.json && !args.message) {
      log.error('--json 模式需要消息：roll chat "<message>" --json');
      process.exitCode = 1;
      return;
    }

    const runtime = await loadRuntime();
    const { ConversationEngine, ThreadStore } = runtime;
    const { model, providerOptions } = resolveLLMCall(
      provider,
      modelName,
      providerConfig.apiKey,
      "chat",
      providerConfig.baseUrl,
      config.runtime.thinkingLevel,
    );
    const store = new ThreadStore(config.runtime.threadsDir);
    const engine = new ConversationEngine({
      config,
      model,
      store,
      policy: createToolPolicy(runtime, config),
      maxSteps: config.runtime.maxSteps,
      ...(providerOptions ? { providerOptions } : {}),
      debugEvents: isDebugLogEnabled(),
      onAgentBootstrapIssue: reportAgentBootstrapIssue,
      onSkillLibraryIssue: reportSkillLibraryIssue,
      sessionExecEnabled: args.message === undefined,
    });

    let sessionForCleanup: AgentSession | undefined;
    try {
      let session: AgentSession;
      if (args.session) {
        session = await engine.resumeSession(args.session);
      } else if (args.last) {
        const latest = store.listThreads()[0];
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
        const result = await runJsonTurn(session, resolveSkillSendText(session, args.message));
        printChatJson(result);
        if (result.status !== "completed") {
          process.exitCode = 1;
        }
        return;
      }

      log.info(`会话 ${session.id}`);
      if (config.runtime.compaction.enabled && session.getContextWindow() === undefined) {
        log.warn(
          `未知模型 "${modelName}" 的 context window，阈值自动压缩不可用。可在 roll.config.yaml 设置 runtime.context-window`,
        );
      }
      if (args.message) {
        const renderer = new ChatRenderer(clackConfirm, session.getContextWindow());
        for await (const event of session.send(resolveSkillSendText(session, args.message))) {
          await renderer.handle(event, session);
        }
      } else {
        const isNewSession = !args.session && !args.last;
        const interactive = Boolean(
          process.stdout.isTTY &&
          process.stdin.isTTY &&
          typeof process.stdin.setRawMode === "function",
        );
        const summary = await engine.getContextSummary();
        const banner: BannerInfo = {
          version: getCurrentVersion(),
          model: modelName,
          agentCount: summary.agentCount,
          skillCount: summary.skillCount,
        };
        let usedInk = false;
        if (interactive) {
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
              onThinkingChange: (level) =>
                session.setProviderOptions(thinkingProviderOptions(provider, modelName, level)),
            });
            usedInk = true;
          } catch (inkError) {
            log.warn(
              `Ink TUI 不可用，回退到基础多轮模式：${inkError instanceof Error ? inkError.message : String(inkError)}`,
            );
          }
        }
        if (!usedInk) {
          process.stderr.write(
            `${renderBannerText(buildBannerLines(banner, process.stdout.columns || 80))}\n`,
          );
          await runRepl(session, store, isNewSession);
        }
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      sessionForCleanup?.abort();
      await engine.dispose();
      store.close();
    }
  },
});
