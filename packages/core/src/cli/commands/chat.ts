import { defineCommand } from "citty";
import type { AgentSession } from "@roll-agent/runtime";
import { loadConfig } from "../../config/loader.ts";
import { createProviderModel } from "../../llm/providers.ts";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import Table from "cli-table3";
import { log } from "../utils/output.ts";
import { ChatRenderer, clackConfirm, type ChatConfirm } from "../utils/chat-renderer.ts";
import type {
  ChatCommandResult,
  ChatPendingAction,
  ChatStepSummary,
  ChatStepUsage,
  ChatTokenUsage,
} from "../../types/chat.ts";
import type { RollConfig } from "../../config/schema.ts";

type RuntimeModule = typeof import("@roll-agent/runtime");

function createToolPolicy(runtime: RuntimeModule, config: RollConfig) {
  return new runtime.ConfigurableToolPolicy({
    defaultMode: config.runtime.approval.default,
    overrides: config.runtime.approval.overrides,
  });
}

type ThreadStoreInstance = InstanceType<RuntimeModule["ThreadStore"]>;

function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
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
  const model = createProviderModel(
    provider,
    modelName,
    providerConfig.apiKey,
    providerConfig.baseUrl,
  );
  const store = new ThreadStore(config.runtime.threadsDir);
  const engine = new ConversationEngine({
    config,
    model,
    store,
    policy: createToolPolicy(runtime, config),
    maxSteps: config.runtime.maxSteps,
    onAgentBootstrapIssue: reportAgentBootstrapIssue,
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
  const pendingActions: ChatPendingAction[] = [];
  let output = "";
  let failure: string | undefined;
  let totalUsage: ChatTokenUsage | undefined;

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
        break;
      case "error":
        failure = event.message;
        break;
      default:
        break;
    }
  }

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
  };
}

async function runRepl(
  session: AgentSession,
  store: ThreadStoreInstance,
  isNewSession: boolean,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => rl.close());
  const confirmFn: ChatConfirm = async (message) => {
    const answer = (await rl.question(`${message} (y/N) `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
  const renderer = new ChatRenderer(confirmFn);
  log.info("进入多轮对话（输入 exit / quit 或 Ctrl-C 退出）");

  let titled = !isNewSession;
  let submitted = false;
  try {
    while (true) {
      let input: string;
      try {
        input = (await rl.question(chalk.green("› "))).trim();
      } catch {
        break;
      }
      if (input.length === 0) {
        continue;
      }
      if (input === "exit" || input === "quit") {
        break;
      }
      if (!titled) {
        store.updateTitle(session.id, titleFromMessage(input));
        titled = true;
      }
      submitted = true;
      for await (const event of session.send(input)) {
        await renderer.handle(event, session);
      }
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
    const model = createProviderModel(
      provider,
      modelName,
      providerConfig.apiKey,
      providerConfig.baseUrl,
    );
    const store = new ThreadStore(config.runtime.threadsDir);
    const engine = new ConversationEngine({
      config,
      model,
      store,
      policy: createToolPolicy(runtime, config),
      maxSteps: config.runtime.maxSteps,
      onAgentBootstrapIssue: reportAgentBootstrapIssue,
    });

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

      if (args.json && args.message) {
        const result = await runJsonTurn(session, args.message);
        printChatJson(result);
        if (result.status !== "completed") {
          process.exitCode = 1;
        }
        return;
      }

      log.info(`会话 ${session.id}`);
      if (args.message) {
        const renderer = new ChatRenderer(clackConfirm);
        for await (const event of session.send(args.message)) {
          await renderer.handle(event, session);
        }
      } else {
        await runRepl(session, store, !args.session && !args.last);
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      await engine.dispose();
      store.close();
    }
  },
});
