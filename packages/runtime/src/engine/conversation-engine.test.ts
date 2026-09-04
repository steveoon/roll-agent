import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import type {
  McpClientManager,
  McpConnectionAcquisition,
} from "@roll-agent/core/mcp/client-manager";
import type { AgentUsageLease } from "@roll-agent/core/registry/agent-usage-lease";
import type { RegisteredAgent } from "@roll-agent/core/types/agent";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { ThreadStore } from "../store/thread-store.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import type { SessionEvent } from "../types/events.ts";
import {
  ConversationEngine,
  type AgentBootstrapIssue,
  buildSessionBashSettings,
  buildSessionExecSettings,
} from "./conversation-engine.ts";
import { CAPABILITY_HOST_MODES } from "./capability-manifest.ts";
import type { ShellProfile } from "../bash/profile.ts";
import { killProcessGroup } from "../bash/kill.ts";
import { executeTranscriptTool } from "../tool-bridge/transcript-tool.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  TOOL_RESOURCE_HINT_KINDS,
} from "../tool-bridge/tool-execution-coordinator.ts";
import { createEmptyCompactionToolState } from "./compaction-checkpoint.ts";
import { createEmptyCompactionSemanticState } from "./compaction-semantic-state.ts";
import { SUMMARY_PREFIX } from "./compactor.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-engine-"));
}

function makeManagedHttpAgent(name: string): RegisteredAgent {
  return {
    skill: { name, description: `${name} test fixture`, metadata: {} },
    transport: { type: "streamable-http", endpoint: `http://127.0.0.1:3199/${name}` },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: `/${name}`, port: 3_199 },
    },
    installPath: `/tmp/${name}`,
    registeredAt: "2026-07-23T00:00:00.000Z",
    status: "online",
  };
}

function fakeAgentUsageLease(agentName: string, release: () => Promise<void>): AgentUsageLease {
  return {
    agentName,
    leaseId: "00000000-0000-4000-8000-000000000001" as AgentUsageLease["leaseId"],
    runtimeIdentity: {
      pid: 123,
      processStartToken:
        "pst-v2:0000000000000000000000000000000000000000000000000000000000000001" as AgentUsageLease["runtimeIdentity"]["processStartToken"],
      startedAt: "2026-07-23T00:00:00.000Z",
    },
    release,
  };
}

function fakeConnectionAcquisition(
  client: unknown,
  options: {
    readonly commit?: () => void;
    readonly rollback?: () => Promise<void>;
  } = {},
): McpConnectionAcquisition {
  return {
    client: client as McpConnectionAcquisition["client"],
    commit: options.commit ?? (() => {}),
    rollback: options.rollback ?? (async () => {}),
  };
}

function bootstrapTimeoutConfig(dataDir: string, timeoutMs: number) {
  const config = installEngineConfig(dataDir);
  return {
    ...config,
    runtime: {
      ...config.runtime,
      agentBootstrap: {
        ...config.runtime.agentBootstrap,
        timeoutMs,
      },
    },
  };
}

function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  const iterator = events[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (next.done !== true) {
    next = await iterator.next();
  }
}

const powershellProfile: ShellProfile = {
  id: "powershell",
  toolName: "powershell",
  supportsSessionExec: true,
  supportsSafeCommandClassification: false,
  buildSpawn: (command, workdir, env) => ({
    file: "pwsh",
    args: ["-EncodedCommand", command],
    options: { cwd: workdir, detached: false, stdio: ["ignore", "pipe", "pipe"], env },
  }),
  classify: () => "unknown",
  killTree: async () => {},
  systemPromptHints: () => ["当前 shell 后端是 PowerShell 7。"],
};

const posixSessionProfile: ShellProfile = {
  id: "posix",
  toolName: "bash",
  supportsSessionExec: true,
  supportsSafeCommandClassification: true,
  buildSpawn: (command, workdir, env) => ({
    file: "/bin/sh",
    args: ["-c", command],
    options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
  }),
  classify: () => "known-safe",
  killTree: async (pid, intent) => {
    killProcessGroup(pid, intent === "interrupt" ? "SIGINT" : "SIGKILL");
  },
  systemPromptHints: () => ["当前 shell 后端是 POSIX shell。"],
};

test("ConversationEngine records runtime model override on created threads", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      runtime: { model: "runtime-model" },
      ask: {},
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
    });

    const session = await engine.createSession();
    const thread = store.getThread(session.id);

    assert.equal(thread?.model, "runtime-model");
    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 同一 thread 复用 live session，显式 close 后允许重建", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
    });

    const created = await engine.createSession();
    const firstResume = await engine.resumeSession(created.id);
    const secondResume = await engine.resumeSession(created.id);
    assert.equal(firstResume, created);
    assert.equal(secondResume, created);

    await created.close();
    const [rebuilt, concurrentlyResumed] = await Promise.all([
      engine.resumeSession(created.id),
      engine.resumeSession(created.id),
    ]);
    assert.notEqual(rebuilt, created);
    assert.equal(concurrentlyResumed, rebuilt);
    assert.equal(await engine.resumeSession(created.id), rebuilt);

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 经过 ThreadStore 重开后保留 Esc 前的对话与恢复上下文", async () => {
  const dir = tempDir();
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  try {
    let calls = 0;
    const firstStore = new ThreadStore(dir);
    const firstEngine = new ConversationEngine({
      config,
      model: new MockLanguageModelV4({
        doStream: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              stream: simulateReadableStream<LanguageModelV4StreamPart>({
                chunks: engineTextStep("步骤 A 已完成"),
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            };
          }
          return {
            stream: simulateReadableStream<LanguageModelV4StreamPart>({
              chunks: engineTextStep("不应完成"),
              initialDelayInMs: 200,
              chunkDelayInMs: null,
            }),
          };
        },
      }),
      store: firstStore,
      sources: [],
      skillLibrary: null,
    });
    const firstSession = await firstEngine.createSession();
    const threadId = firstSession.id;
    await drain(firstSession.send("先完成步骤 A"));
    const cancelledEvents: SessionEvent[] = [];
    for await (const event of firstSession.send("开始步骤 B")) {
      cancelledEvents.push(event);
      if (event.type === "message-start") {
        firstSession.cancel();
      }
    }
    assert.equal(
      cancelledEvents.some((event) => event.type === "turn-cancelled"),
      true,
    );
    await firstEngine.dispose();
    firstStore.close();

    let recoveryPrompt: LanguageModelV4CallOptions["prompt"] = [];
    const reopenedStore = new ThreadStore(dir);
    const reopenedEngine = new ConversationEngine({
      config,
      model: textModelCapture((options) => {
        recoveryPrompt = options.prompt;
      }),
      store: reopenedStore,
      sources: [],
      skillLibrary: null,
    });
    const resumed = await reopenedEngine.resumeSession(threadId);
    assert.doesNotMatch(
      JSON.stringify(resumed.getMessages()),
      /cancelledTurnRecovery|Roll interrupted-turn recovery checkpoint/u,
    );
    await drain(resumed.send("继续"));

    const serializedRecoveryPrompt = JSON.stringify(recoveryPrompt);
    assert.match(serializedRecoveryPrompt, /先完成步骤 A|步骤 A 已完成/u);
    assert.match(serializedRecoveryPrompt, /开始步骤 B/u);
    const recoveryCallMessage = recoveryPrompt.find(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) =>
            part.type === "tool-call" && part.toolName === "roll__interrupted_turn_recovery",
        ),
    );
    const recoveryToolMessage = recoveryPrompt.find(
      (message) =>
        message.role === "tool" &&
        message.content.some(
          (part) =>
            part.type === "tool-result" && part.toolName === "roll__interrupted_turn_recovery",
        ),
    );
    assert.ok(recoveryCallMessage);
    assert.ok(recoveryToolMessage?.role === "tool");
    const recoveryResult = recoveryToolMessage.content.find(
      (part) => part.type === "tool-result" && part.toolName === "roll__interrupted_turn_recovery",
    );
    assert.ok(recoveryResult && recoveryResult.type === "tool-result");
    assert.equal(recoveryResult.output.type, "text");
    if (recoveryResult.output.type === "text") {
      assert.match(recoveryResult.output.value, /"source":"roll-runtime-tool-ledger"/u);
      assert.match(recoveryResult.output.value, /已完成的步骤和工具记录仍然有效/u);
    }
    assert.doesNotMatch(serializedRecoveryPrompt, /rollHarness|cancelledTurnRecovery/u);

    await reopenedEngine.dispose();
    reopenedStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine dispose 开始后拒绝新的 create 与 resume", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
    });
    const session = await engine.createSession();

    const disposing = engine.dispose();
    await assert.rejects(engine.createSession(), /ConversationEngine is closing/u);
    await assert.rejects(engine.resumeSession(session.id), /ConversationEngine is closing/u);
    await assert.rejects(engine.getContextSummary(), /ConversationEngine is closing/u);
    await disposing;
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine dispose 与 in-flight bootstrap 竞态不注册迟到 session", async () => {
  const dir = tempDir();
  try {
    const bootstrapStarted = Promise.withResolvers<void>();
    const releaseBootstrap = Promise.withResolvers<void>();
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const agent: RegisteredAgent = {
      skill: { name: "slow-agent", description: "slow", metadata: {} },
      transport: { type: "streamable-http", endpoint: "http://127.0.0.1:3199/mcp" },
      runtime: {
        ownership: "core-managed",
        start: { command: "node", args: ["dist/index.js"] },
        endpoint: { path: "/mcp", port: 3199 },
      },
      installPath: "/tmp/slow-agent",
      registeredAt: "2026-07-13T00:00:00.000Z",
      status: "stopped",
    };
    let connectCalls = 0;
    const clientManager = {
      connect: async () => {
        connectCalls += 1;
        return { listTools: async () => ({ tools: [] }) };
      },
      disconnectAll: async () => {},
    } as unknown as McpClientManager;
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: new MockLanguageModelV4({}),
      store,
      agents: [agent],
      skillLibrary: null,
      clientManager,
      ensureAgentReady: async () => {
        bootstrapStarted.resolve();
        await releaseBootstrap.promise;
      },
    });

    const creating = engine.createSession();
    const rejectedCreate = assert.rejects(creating, /ConversationEngine is closing/u);
    await bootstrapStarted.promise;
    const disposing = engine.dispose();
    releaseBootstrap.resolve();
    await Promise.all([disposing, rejectedCreate]);
    assert.equal(connectCalls, 0);
    assert.deepEqual(store.listThreads(), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine dispose 等待并清理忽略 signal 的迟到新连接", async () => {
  const agent = makeManagedHttpAgent("late-connect-agent");
  const connectStarted = Promise.withResolvers<void>();
  const releaseConnect = Promise.withResolvers<void>();
  const order: string[] = [];
  const issues: AgentBootstrapIssue[] = [];
  const client = {
    listTools: async () => {
      order.push("list");
      return { tools: [] };
    },
  };
  const clientManager = {
    connectWithOwnership: async () => {
      order.push("connect");
      connectStarted.resolve();
      await releaseConnect.promise;
      order.push("connected");
      return fakeConnectionAcquisition(client, {
        rollback: async () => {
          order.push("disconnect");
        },
      });
    },
    disconnectAll: async () => {
      order.push("disconnect-all");
    },
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-late-connect"),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async () => {},
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const creating = engine.createSession();
  await connectStarted.promise;
  const disposing = engine.dispose();
  releaseConnect.resolve();

  await assert.rejects(creating, /ConversationEngine is closing/u);
  await disposing;
  assert.deepEqual(order, ["connect", "connected", "disconnect", "disconnect-all"]);
  assert.deepEqual(issues, []);
});

test("ConversationEngine.dispose 等待 live session close 后才断开 MCP", async () => {
  const order: string[] = [];
  const closeStarted = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const clientManager = {
    disconnectAll: async () => {
      order.push("disconnect");
    },
  } as unknown as McpClientManager;
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({}),
    sources: [],
    clientManager,
  });
  const session = await engine.createSession();
  const originalClose = session.close.bind(session);
  session.close = async () => {
    order.push("close-start");
    closeStarted.resolve();
    await releaseClose.promise;
    await originalClose();
    order.push("close-end");
  };

  const disposing = engine.dispose();
  try {
    await closeStarted.promise;
    assert.deepEqual(order, ["close-start"]);
    releaseClose.resolve();
    await disposing;
    assert.deepEqual(order, ["close-start", "close-end", "disconnect"]);
  } finally {
    releaseClose.resolve();
    await disposing;
  }
});

test("ConversationEngine.dispose 先断开 MCP，再释放持有的 Agent 使用租约", async () => {
  const order: string[] = [];
  const agent = makeManagedHttpAgent("leased-agent");
  const lease = fakeAgentUsageLease(agent.skill.name, async () => {
    order.push("release");
  });
  const clientManager = {
    connect: async () => ({
      listTools: async () => ({ tools: [] }),
    }),
    disconnectAll: async () => {
      order.push("disconnect");
    },
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-lease-order"),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    clientManager,
    acquireAgentUsage: async () => lease,
  });

  await engine.createSession();
  await engine.dispose();

  assert.deepEqual(order, ["disconnect", "release"]);
});

test("ConversationEngine.dispose 在 MCP 断开失败时仍释放 Agent 使用租约", async () => {
  const order: string[] = [];
  const agent = makeManagedHttpAgent("disconnect-failure-agent");
  const lease = fakeAgentUsageLease(agent.skill.name, async () => {
    order.push("release");
  });
  const clientManager = {
    connect: async () => ({
      listTools: async () => ({ tools: [] }),
    }),
    disconnectAll: async () => {
      order.push("disconnect");
      throw new Error("disconnect failed");
    },
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-disconnect-failure"),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    clientManager,
    acquireAgentUsage: async () => lease,
  });

  await engine.createSession();
  await assert.rejects(engine.dispose(), /disconnect failed/u);

  assert.deepEqual(order, ["disconnect", "release"]);
});

test("ConversationEngine 在 MCP tools/list 失败时断开连接并释放刚取得的使用租约", async () => {
  const order: string[] = [];
  const issues: AgentBootstrapIssue[] = [];
  const agent = makeManagedHttpAgent("broken-leased-agent");
  const lease = fakeAgentUsageLease(agent.skill.name, async () => {
    order.push("release");
  });
  const client = {
    listTools: async () => {
      throw new Error("list failed");
    },
  };
  const clientManager = {
    connectWithOwnership: async () =>
      fakeConnectionAcquisition(client, {
        rollback: async () => {
          order.push("disconnect");
        },
      }),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-lease-failure"),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    clientManager,
    acquireAgentUsage: async () => lease,
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  await engine.createSession();

  assert.deepEqual(order, ["disconnect", "release"]);
  assert.equal(issues[0]?.agentName, agent.skill.name);
  assert.match(issues[0]?.message ?? "", /list failed/u);
  await engine.dispose();
});

test("ConversationEngine.dispose 在 session close 失败时仍通过 finally 断开 MCP", async () => {
  const order: string[] = [];
  const clientManager = {
    disconnectAll: async () => {
      order.push("disconnect");
    },
  } as unknown as McpClientManager;
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({}),
    sources: [],
    clientManager,
  });
  const session = await engine.createSession();
  session.close = async () => {
    order.push("close");
    throw new Error("close failed");
  };

  await assert.rejects(engine.dispose(), /close failed/u);
  assert.deepEqual(order, ["close", "disconnect"]);
});

test("ConversationEngine reports agent bootstrap failures instead of swallowing them", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const agent: RegisteredAgent = {
    skill: { name: "broken-agent", description: "broken", metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    installPath: "/tmp/broken-agent",
    registeredAt: "2026-06-17T00:00:00.000Z",
    status: "idle",
  };
  const issues: AgentBootstrapIssue[] = [];
  const clientManager = {
    connect: async () => {
      throw new Error("connect failed");
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    clientManager,
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  await engine.createSession();

  assert.deepEqual(issues, [{ agentName: "broken-agent", message: "connect failed" }]);
  await engine.dispose();
});

test("ConversationEngine 并发 createSession 仍只执行一次 bootstrap", async () => {
  const agents = [makeManagedHttpAgent("single-flight-a"), makeManagedHttpAgent("single-flight-b")];
  const gates = agents.map(() => Promise.withResolvers<void>());
  const starts = agents.map(() => Promise.withResolvers<void>());
  const connectCalls: string[] = [];
  const clientManager = {
    connect: async (agentName: string) => {
      const index = agents.findIndex((agent) => agent.skill.name === agentName);
      assert.notEqual(index, -1);
      const start = starts[index];
      const gate = gates[index];
      assert.ok(start);
      assert.ok(gate);
      connectCalls.push(agentName);
      start.resolve();
      await gate.promise;
      return { listTools: async () => ({ tools: [] }) };
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-single-flight"),
    model: new MockLanguageModelV4({}),
    agents,
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async () => {},
  });

  const creating = Promise.all([engine.createSession(), engine.createSession()]);
  await Promise.all(starts.map(({ promise }) => promise));
  assert.deepEqual(connectCalls, ["single-flight-a", "single-flight-b"]);
  for (const gate of gates) {
    gate.resolve();
  }
  const sessions = await creating;

  assert.equal(sessions.length, 2);
  assert.equal(new Set(sessions.map((session) => session.id)).size, 2);
  assert.deepEqual(connectCalls, ["single-flight-a", "single-flight-b"]);
  await engine.dispose();
});

test("ConversationEngine 逆序完成时按注册顺序输出 issue、source 与 Tool ID 冲突归属", async () => {
  const agents = [
    makeManagedHttpAgent("alpha.beta"),
    makeManagedHttpAgent("broken-agent"),
    makeManagedHttpAgent("alpha_beta"),
  ];
  const gates = agents.map(() => Promise.withResolvers<void>());
  const starts = agents.map(() => Promise.withResolvers<void>());
  const completions = agents.map(() => Promise.withResolvers<void>());
  const completionOrder: string[] = [];
  const issues: AgentBootstrapIssue[] = [];
  const clientManager = {
    connect: async (agentName: string) => {
      const index = agents.findIndex((agent) => agent.skill.name === agentName);
      assert.notEqual(index, -1);
      const start = starts[index];
      const gate = gates[index];
      const completion = completions[index];
      assert.ok(start);
      assert.ok(gate);
      assert.ok(completion);
      start.resolve();
      await gate.promise;
      completionOrder.push(agentName);
      completion.resolve();
      if (agentName === "broken-agent") {
        throw new Error("broken connect");
      }
      return {
        listTools: async () => ({
          tools: [
            {
              name: "shared",
              description: `${agentName} shared tool`,
              inputSchema: { type: "object", properties: {} },
              _meta: { "roll/resourceHints": "invalid" },
            },
          ],
        }),
      };
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-stable-bootstrap"),
    model: new MockLanguageModelV4({}),
    agents,
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async () => {},
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const creating = engine.createSession();
  await Promise.all([starts[0]?.promise, starts[1]?.promise]);
  gates[1]?.resolve();
  await completions[1]?.promise;
  await starts[2]?.promise;
  gates[2]?.resolve();
  await completions[2]?.promise;
  gates[0]?.resolve();
  const session = await creating;

  assert.deepEqual(completionOrder, ["broken-agent", "alpha_beta", "alpha.beta"]);
  assert.deepEqual(
    issues.map((issue) => issue.agentName),
    ["alpha.beta", "broken-agent", "alpha_beta"],
  );
  assert.match(issues[0]?.message ?? "", /roll\/resourceHints 无效/u);
  assert.equal(issues[1]?.message, "broken connect");
  assert.match(issues[2]?.message ?? "", /roll\/resourceHints 无效/u);

  const agentTools = session
    .getCapabilityManifest()
    .tools.filter((tool) => tool.agentName === "alpha.beta" || tool.agentName === "alpha_beta");
  assert.deepEqual(
    agentTools.map((tool) => ({ id: tool.id, agentName: tool.agentName })),
    [
      { id: "alpha_beta__shared", agentName: "alpha.beta" },
      { id: "alpha_beta__shared_1", agentName: "alpha_beta" },
    ],
  );
  assert.equal(session.getCapabilityManifest().agentCount, 2);
  await engine.dispose();
});

test("ConversationEngine 全局 bootstrap 超时返回部分 catalog，且不启动排队 Agent", async () => {
  const agents = [
    makeManagedHttpAgent("ready-agent"),
    ...Array.from({ length: 7 }, (_, index) => makeManagedHttpAgent(`slow-agent-${index + 1}`)),
  ];
  const fifthConnectStarted = Promise.withResolvers<void>();
  const connectAbortObserved = Promise.withResolvers<void>();
  const releaseCancelledConnects = Promise.withResolvers<void>();
  const connectStarts: string[] = [];
  const issues: AgentBootstrapIssue[] = [];
  let createSettled = false;

  const readyClient = {
    listTools: async () => ({
      tools: [
        {
          name: "ready",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    }),
  };
  const clientManager = {
    connectWithOwnership: async (
      agentName: string,
      _transport: unknown,
      _cwd: string,
      options: { readonly signal?: AbortSignal },
    ) => {
      connectStarts.push(agentName);
      if (connectStarts.length === 5) {
        fifthConnectStarted.resolve();
      }
      if (agentName === "ready-agent") {
        return fakeConnectionAcquisition(readyClient);
      }
      assert.ok(options.signal);
      await waitUntilAborted(options.signal);
      connectAbortObserved.resolve();
      await releaseCancelledConnects.promise;
      throw options.signal.reason;
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: bootstrapTimeoutConfig("/tmp/roll-engine-bootstrap-timeout", 50),
    model: new MockLanguageModelV4({}),
    agents,
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async () => {},
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const creating = engine.createSession().then((session) => {
    createSettled = true;
    return session;
  });
  await fifthConnectStarted.promise;
  await connectAbortObserved.promise;

  assert.equal(createSettled, false);
  assert.deepEqual(
    connectStarts,
    agents.slice(0, 5).map((agent) => agent.skill.name),
  );

  releaseCancelledConnects.resolve();
  const session = await creating;

  assert.equal(session.getCapabilityManifest().agentCount, 1);
  assert.deepEqual(
    issues.map((issue) => issue.agentName),
    agents.slice(1).map((agent) => agent.skill.name),
  );
  for (const issue of issues) {
    assert.equal(issue.message, "Agent bootstrap timed out after 50ms");
  }
  assert.deepEqual(
    connectStarts,
    agents.slice(0, 5).map((agent) => agent.skill.name),
  );
  await engine.dispose();
});

test("ConversationEngine tools/list 超时取消后清理新连接与新租约再返回", async () => {
  const agent = makeManagedHttpAgent("list-timeout-agent");
  const order: string[] = [];
  const issues: AgentBootstrapIssue[] = [];
  const lease = fakeAgentUsageLease(agent.skill.name, async () => {
    order.push("release");
  });
  const client = {
    listTools: async (_params: unknown, options: { readonly signal?: AbortSignal } | undefined) => {
      assert.ok(options?.signal);
      await waitUntilAborted(options.signal);
      order.push("list-abort");
      throw options.signal.reason;
    },
  };
  const clientManager = {
    connectWithOwnership: async () =>
      fakeConnectionAcquisition(client, {
        rollback: async () => {
          order.push("disconnect");
        },
      }),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: bootstrapTimeoutConfig("/tmp/roll-engine-list-timeout", 50),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    acquireAgentUsage: async () => lease,
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const session = await engine.createSession();

  assert.equal(session.getCapabilityManifest().agentCount, 0);
  assert.deepEqual(order, ["list-abort", "disconnect", "release"]);
  assert.deepEqual(issues, [
    {
      agentName: agent.skill.name,
      message: "Agent bootstrap timed out after 50ms",
    },
  ]);
  await engine.dispose();
  assert.deepEqual(order, ["list-abort", "disconnect", "release"]);
});

test("ConversationEngine 报告 bootstrap 清理失败并在 dispose 重试租约释放", async () => {
  const agent = makeManagedHttpAgent("cleanup-failure-agent");
  const order: string[] = [];
  const issues: AgentBootstrapIssue[] = [];
  let releaseCalls = 0;
  const lease = fakeAgentUsageLease(agent.skill.name, async () => {
    releaseCalls += 1;
    order.push(`release-${String(releaseCalls)}`);
    if (releaseCalls === 1) {
      throw new Error("lease cleanup failed");
    }
  });
  const client = {
    listTools: async (_params: unknown, options: { readonly signal?: AbortSignal } | undefined) => {
      assert.ok(options?.signal);
      await waitUntilAborted(options.signal);
      order.push("list-abort");
      throw options.signal.reason;
    },
  };
  const clientManager = {
    connectWithOwnership: async () =>
      fakeConnectionAcquisition(client, {
        rollback: async () => {
          order.push("rollback");
          throw new Error("connection cleanup failed");
        },
      }),
    disconnectAll: async () => {
      order.push("disconnect-all");
    },
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: bootstrapTimeoutConfig("/tmp/roll-engine-cleanup-failure", 50),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    acquireAgentUsage: async () => lease,
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const session = await engine.createSession();

  assert.equal(session.getCapabilityManifest().agentCount, 0);
  assert.deepEqual(order, ["list-abort", "rollback", "release-1"]);
  assert.equal(issues[0]?.message, "Agent bootstrap timed out after 50ms");
  assert.match(issues[1]?.message ?? "", /connection cleanup failed/u);
  assert.match(issues[1]?.message ?? "", /lease cleanup failed/u);

  await engine.dispose();
  assert.deepEqual(order, ["list-abort", "rollback", "release-1", "disconnect-all", "release-2"]);
});

test("ConversationEngine refresh 不复用已经结束的 startup timeout signal", async () => {
  const agent = makeManagedHttpAgent("refresh-after-timeout-agent");
  const issues: AgentBootstrapIssue[] = [];
  let connectCalls = 0;
  const client = {
    listTools: async () => ({ tools: [] }),
  };
  const clientManager = {
    connectWithOwnership: async (
      _agentName: string,
      _transport: unknown,
      _cwd: string,
      options: { readonly signal?: AbortSignal },
    ) => {
      connectCalls += 1;
      if (connectCalls === 1) {
        assert.ok(options.signal);
        await waitUntilAborted(options.signal);
        throw options.signal.reason;
      }
      assert.equal(options.signal?.aborted, false);
      return fakeConnectionAcquisition(client);
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: bootstrapTimeoutConfig("/tmp/roll-engine-refresh-after-timeout", 50),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async () => {},
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const session = await engine.createSession();
  assert.equal(session.getCapabilityManifest().agentCount, 0);
  assert.equal(issues.length, 1);

  const refresh = await engine.prepareAgentRefresh(agent);
  assert.equal(refresh.source.agentName, agent.skill.name);
  assert.equal(connectCalls, 2);
  await engine.dispose();
});

test("ConversationEngine dispose 优先于 bootstrap timeout，并取消 readiness 且不报告伪 timeout", async () => {
  const agent = makeManagedHttpAgent("closing-readiness-agent");
  const readinessStarted = Promise.withResolvers<void>();
  const readinessAborted = Promise.withResolvers<void>();
  const issues: AgentBootstrapIssue[] = [];
  let connectCalls = 0;
  const clientManager = {
    connectWithOwnership: async () => {
      connectCalls += 1;
      throw new Error("must not connect after readiness cancellation");
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: bootstrapTimeoutConfig("/tmp/roll-engine-closing-readiness", 5_000),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async (_readyAgent, _env, signal) => {
      assert.ok(signal);
      readinessStarted.resolve();
      await waitUntilAborted(signal);
      readinessAborted.resolve();
      throw signal.reason;
    },
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const creating = engine.createSession();
  await readinessStarted.promise;
  const disposing = engine.dispose();
  await readinessAborted.promise;

  await assert.rejects(creating, {
    message: "ConversationEngine is closing",
  });
  await disposing;
  assert.equal(connectCalls, 0);
  assert.deepEqual(issues, []);
});

test("ConversationEngine refresh 失败不释放既有共享连接与既有租约", async () => {
  const agent = makeManagedHttpAgent("shared-refresh-agent");
  let listCalls = 0;
  let disconnectCalls = 0;
  let releaseCalls = 0;
  const lease = fakeAgentUsageLease(agent.skill.name, async () => {
    releaseCalls += 1;
  });
  const client = {
    listTools: async () => {
      listCalls += 1;
      if (listCalls === 2) {
        throw new Error("refresh list failed");
      }
      return { tools: [] };
    },
  };
  const clientManager = {
    connectWithOwnership: async () => fakeConnectionAcquisition(client),
    disconnect: async () => {
      disconnectCalls += 1;
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-shared-refresh"),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    acquireAgentUsage: async () => lease,
  });

  await engine.createSession();
  await assert.rejects(engine.prepareAgentRefresh(agent), /refresh list failed/u);

  assert.equal(disconnectCalls, 0);
  assert.equal(releaseCalls, 0);
  await engine.dispose();
  assert.equal(releaseCalls, 1);
});

test("ConversationEngine explicitSources 继续直接绕过 Agent bootstrap", async () => {
  const agent = makeManagedHttpAgent("must-not-connect");
  let connectCalls = 0;
  let readinessCalls = 0;
  let catalogCalls = 0;
  const clientManager = {
    connect: async () => {
      connectCalls += 1;
      throw new Error("explicitSources must bypass connect");
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-explicit-sources"),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    sources: [],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async () => {
      readinessCalls += 1;
    },
    resolveCatalogFn: async () => {
      catalogCalls += 1;
      throw new Error("explicitSources must bypass catalog resolution");
    },
  });

  const session = await engine.createSession();

  assert.equal(session.getCapabilityManifest().agentCount, 0);
  assert.equal(connectCalls, 0);
  assert.equal(readinessCalls, 0);
  assert.equal(catalogCalls, 0);
  await engine.dispose();
});

test("ConversationEngine catalog resolution 使用同一 bootstrap budget 与 signal", async () => {
  const dir = tempDir();
  let observedSignal: AbortSignal | undefined;
  let engine: ConversationEngine | undefined;
  try {
    engine = new ConversationEngine({
      config: bootstrapTimeoutConfig(dir, 50),
      model: new MockLanguageModelV4({}),
      skillLibrary: null,
      shellProfile: null,
      resolveCatalogFn: async (_config, options) => {
        const signal = options?.signal;
        assert.ok(signal);
        observedSignal = signal;
        await waitUntilAborted(signal);
        throw signal.reason;
      },
    });

    const startedAt = Date.now();
    const session = await engine.createSession();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(session.getCapabilityManifest().agentCount, 0);
    assert.equal(observedSignal?.aborted, true);
    assert.ok(elapsedMs >= 25, `catalog timeout returned too early: ${String(elapsedMs)}ms`);
    assert.ok(elapsedMs < 1_000, `catalog timeout exceeded bounded budget: ${String(elapsedMs)}ms`);
  } finally {
    await engine?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine prepareAgentRefresh 保持串行并即时报告 resourceHints issue", async () => {
  const agents = [makeManagedHttpAgent("refresh-a"), makeManagedHttpAgent("refresh-b")];
  const firstAgent = agents[0];
  const secondAgent = agents[1];
  assert.ok(firstAgent);
  assert.ok(secondAgent);
  const gates = agents.map(() => Promise.withResolvers<void>());
  const starts = agents.map(() => Promise.withResolvers<void>());
  const connectOrder: string[] = [];
  const issues: AgentBootstrapIssue[] = [];
  const clientManager = {
    connect: async (agentName: string) => {
      const index = agents.findIndex((agent) => agent.skill.name === agentName);
      assert.notEqual(index, -1);
      const start = starts[index];
      const gate = gates[index];
      assert.ok(start);
      assert.ok(gate);
      connectOrder.push(agentName);
      start.resolve();
      await gate.promise;
      return {
        listTools: async () => ({
          tools: [
            {
              name: "refresh",
              inputSchema: { type: "object", properties: {} },
              ...(agentName === "refresh-a" ? { _meta: { "roll/resourceHints": "invalid" } } : {}),
            },
          ],
        }),
      };
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config: installEngineConfig("/tmp/roll-engine-refresh-chain"),
    model: new MockLanguageModelV4({}),
    agents: [],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    ensureAgentReady: async () => {},
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });
  await engine.createSession();

  const firstRefresh = engine.prepareAgentRefresh(firstAgent);
  await starts[0]?.promise;
  const secondRefresh = engine.prepareAgentRefresh(secondAgent);
  await Promise.resolve();
  assert.deepEqual(connectOrder, ["refresh-a"]);

  gates[0]?.resolve();
  await firstRefresh;
  await starts[1]?.promise;
  assert.deepEqual(connectOrder, ["refresh-a", "refresh-b"]);
  assert.deepEqual(
    issues.map((issue) => issue.agentName),
    ["refresh-a"],
  );
  assert.match(issues[0]?.message ?? "", /roll\/resourceHints 无效/u);

  gates[1]?.resolve();
  await secondRefresh;
  await engine.dispose();
});

test("ConversationEngine ensures core-managed agents before connecting", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: {
      dataDir: "/tmp/roll-engine-test",
      env: {
        "browser-use-agent": {
          TEST_ENV: "1",
        },
      },
    },
  });
  const agent: RegisteredAgent = {
    skill: { name: "browser-use-agent", description: "browser", metadata: {} },
    transport: { type: "streamable-http", endpoint: "http://127.0.0.1:3100/mcp" },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: "/mcp", port: 3100 },
    },
    installPath: "/tmp/browser-use-agent",
    registeredAt: "2026-06-17T00:00:00.000Z",
    status: "stopped",
    source: { type: "remote-manifest", endpoint: "https://agents.example/browser" },
  };
  const ensured: Array<{
    readonly agentName: string;
    readonly env: Readonly<Record<string, string>> | undefined;
  }> = [];
  const connected: string[] = [];
  const clientManager = {
    connect: async (agentName: string) => {
      connected.push(agentName);
      return {
        listTools: async () => ({
          tools: [
            {
              name: "inspect",
              description: "inspect browser",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
          ],
        }),
      };
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    clientManager,
    ensureAgentReady: async (agent, env) => {
      ensured.push({ agentName: agent.skill.name, env });
    },
  });

  const session = await engine.createSession();

  assert.deepEqual(ensured, [{ agentName: "browser-use-agent", env: { TEST_ENV: "1" } }]);
  assert.deepEqual(connected, ["browser-use-agent"]);
  const capability = session
    .getCapabilityManifest()
    .tools.find((tool) => tool.id === "browser-use-agent__inspect");
  assert.equal(capability?.source, "remote-manifest");
  assert.equal(capability?.transport, "streamable-http");
  assert.equal(capability?.runtimeOwnership, "core-managed");
  assert.deepEqual(capability?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
  });
  await engine.dispose();
});

test("ConversationEngine threads its providerOptions into sub-agent sampling connect calls", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const agent: RegisteredAgent = {
    skill: { name: "sampling-agent", description: "sampling", metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    installPath: "/tmp/sampling-agent",
    registeredAt: "2026-06-17T00:00:00.000Z",
    status: "idle",
  };
  const connectOptionsCalls: Array<{
    readonly samplingModel?: unknown;
    readonly samplingProviderOptions?: unknown;
  }> = [];
  const updatedProviderOptions: unknown[] = [];
  const clientManager = {
    connect: async (
      _agentName: string,
      _transport: unknown,
      _cwd: string,
      options: { readonly samplingModel?: unknown; readonly samplingProviderOptions?: unknown },
    ) => {
      connectOptionsCalls.push(options);
      return { listTools: async () => ({ tools: [] }) };
    },
    setSamplingProviderOptions: (providerOptions: unknown) => {
      updatedProviderOptions.push(providerOptions);
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const providerOptions = { anthropic: { thinking: { type: "adaptive" }, effort: "high" } };
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    clientManager,
    providerOptions,
  });

  const session = await engine.createSession();

  assert.equal(connectOptionsCalls.length, 1);
  assert.ok(connectOptionsCalls[0]?.samplingModel);
  assert.deepEqual(connectOptionsCalls[0]?.samplingProviderOptions, providerOptions);
  const nextProviderOptions = { anthropic: { thinking: { type: "adaptive" }, effort: "low" } };
  session.setProviderOptions(nextProviderOptions);
  assert.deepEqual(updatedProviderOptions, [nextProviderOptions]);

  await engine.prepareAgentRefresh(agent);
  assert.deepEqual(connectOptionsCalls[1]?.samplingProviderOptions, nextProviderOptions);
  await engine.dispose();
});

test("ConversationEngine.switchModel updates live sessions, sampling and thread model", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const agent: RegisteredAgent = {
    skill: { name: "sampling-agent", description: "sampling", metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    installPath: "/tmp/sampling-agent",
    registeredAt: "2026-06-17T00:00:00.000Z",
    status: "idle",
  };
  const samplingModels: unknown[] = [];
  const samplingOptions: unknown[] = [];
  const connectOptionsCalls: Array<{ readonly samplingModel?: unknown }> = [];
  const clientManager = {
    connect: async (
      _agentName: string,
      _transport: unknown,
      _cwd: string,
      options: { readonly samplingModel?: unknown },
    ) => {
      connectOptionsCalls.push(options);
      return { listTools: async () => ({ tools: [] }) };
    },
    setSamplingProviderOptions: (options: unknown) => samplingOptions.push(options),
    setSamplingModel: (model: unknown) => samplingModels.push(model),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const dir = tempDir();
  const store = new ThreadStore(dir);
  const initial = new MockLanguageModelV4({ modelId: "initial" });
  const engine = new ConversationEngine({
    config,
    model: initial,
    agents: [agent],
    skillLibrary: null,
    clientManager,
    store,
  });
  try {
    const session = await engine.createSession();
    assert.equal(store.getThread(session.id)?.model, "default-model");

    const next = new MockLanguageModelV4({ modelId: "gemini-3.8-flash" });
    engine.switchModel({
      provider: "mock",
      modelName: "gemini-3.8-flash",
      model: next,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: "medium" } } },
    });

    assert.deepEqual(samplingModels, [next]);
    assert.deepEqual(samplingOptions, [
      { google: { thinkingConfig: { thinkingLevel: "medium" } } },
    ]);
    assert.equal(store.getThread(session.id)?.model, "gemini-3.8-flash");
    assert.equal(session.getContextWindow(), 1_000_000);

    const created = await engine.createSession();
    assert.equal(store.getThread(created.id)?.model, "gemini-3.8-flash");

    await engine.prepareAgentRefresh(agent);
    assert.equal(connectOptionsCalls.at(-1)?.samplingModel, next);
  } finally {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine.switchModel preflights live sessions before mutating any state", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const samplingModels: unknown[] = [];
  const samplingOptions: unknown[] = [];
  const clientManager = {
    setSamplingProviderOptions: (options: unknown) => samplingOptions.push(options),
    setSamplingModel: (model: unknown) => samplingModels.push(model),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const initial = new MockLanguageModelV4({ modelId: "initial" });
  const next = new MockLanguageModelV4({ modelId: "next" });
  const engine = new ConversationEngine({
    config,
    model: initial,
    sources: [],
    skillLibrary: null,
    clientManager,
  });
  const idle = await engine.createSession();
  const busy = await engine.createSession();
  Reflect.set(busy, "activeTurn", {});
  try {
    assert.throws(
      () => engine.switchModel({ provider: "mock", modelName: "next", model: next }),
      /正在生成回复/u,
    );
    assert.equal(Reflect.get(idle, "model"), initial);
    assert.equal(Reflect.get(engine, "modelOverride"), undefined);
    assert.deepEqual(samplingModels, []);
    assert.deepEqual(samplingOptions, []);
  } finally {
    Reflect.set(busy, "activeTurn", undefined);
    await engine.dispose();
  }
});

test("ConversationEngine resolves context window from the model catalog by provider and reports the source", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-terra",
      providers: { openai: { apiKey: "test" }, google: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const catalog = new ModelCatalog({
    snapshot: {
      fetchedAt: "2026-09-04T00:00:00.000Z",
      providers: {
        openai: { "gpt-5.6-terra": { context: 1_050_000, input: 922_000 } },
        google: { "gemini-3.8-flash": { context: 1_048_576 } },
      },
    },
  });
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({ modelId: "gpt-5.6-terra" }),
    sources: [],
    skillLibrary: null,
    modelCatalog: catalog,
  });
  try {
    const session = await engine.createSession();
    assert.equal(session.getContextWindow(), 922_000);

    const switched = engine.switchModel({
      provider: "google",
      modelName: "gemini-3.8-flash",
      model: new MockLanguageModelV4({ modelId: "gemini-3.8-flash" }),
    });
    assert.deepEqual(switched, { window: 1_048_576, source: "catalog" });
    assert.equal(session.getContextWindow(), 1_048_576);

    const ruled = engine.switchModel({
      provider: "xai",
      modelName: "grok-4.5",
      model: new MockLanguageModelV4({ modelId: "grok-4.5" }),
    });
    assert.deepEqual(ruled, { window: 500_000, source: "rule" });
  } finally {
    await engine.dispose();
  }
});

test("ConversationEngine drops tools with unresolved refs for providers that reject them and keeps them otherwise", async () => {
  const agent: RegisteredAgent = {
    skill: { name: "schema-agent", description: "schema", metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    installPath: "/tmp/schema-agent",
    registeredAt: "2026-06-17T00:00:00.000Z",
    status: "idle",
  };
  const recursiveTool = {
    name: "tree",
    inputSchema: {
      type: "object",
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
      properties: { root: { $ref: "#/$defs/node" } },
    },
  };
  const plainTool = { name: "ping", inputSchema: { type: "object", properties: {} } };
  const makeEngine = (provider: string) => {
    const issues: string[] = [];
    const engine = new ConversationEngine({
      config: rollConfigSchema.parse({
        llm: {
          defaultProvider: provider,
          defaultModel: "m",
          providers: { [provider]: { apiKey: "k" } },
        },
        ask: {},
        agents: { dataDir: "/tmp/roll-engine-test" },
      }),
      model: new MockLanguageModelV4({}),
      agents: [agent],
      skillLibrary: null,
      clientManager: {
        connect: async () => ({ listTools: async () => ({ tools: [recursiveTool, plainTool] }) }),
        setSamplingProviderOptions: () => {},
        setSamplingModel: () => {},
        disconnectAll: async () => {},
      } as unknown as McpClientManager,
      onAgentBootstrapIssue: (issue) => issues.push(issue.message),
    });
    return { engine, issues };
  };

  const google = makeEngine("google");
  try {
    const session = await google.engine.createSession();
    const ids = session.getCapabilityManifest().tools.map((tool) => tool.id);
    assert.ok(ids.some((id) => id.endsWith("ping")));
    assert.ok(!ids.some((id) => id.endsWith("tree")));
    assert.ok(google.issues.some((message) => message.includes("递归引用")));
    assert.ok(google.issues.some((message) => message.includes("已从本会话工具集移除")));
  } finally {
    await google.engine.dispose();
  }

  const openai = makeEngine("openai");
  try {
    const session = await openai.engine.createSession();
    const ids = session.getCapabilityManifest().tools.map((tool) => tool.id);
    assert.ok(ids.some((id) => id.endsWith("tree")));
    assert.ok(openai.issues.some((message) => message.includes("递归引用")));
  } finally {
    await openai.engine.dispose();
  }
});

test("ConversationEngine threads structured output controls into AgentSession", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const structuredOutputProviderOptions = { alibaba: { enableThinking: false } };
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({}),
    sources: [],
    skillLibrary: null,
    structuredOutputProviderOptions,
    structuredOutputReasoning: "high",
  });

  const session = await engine.createSession();

  assert.deepEqual(
    Reflect.get(session, "structuredOutputProviderOptions"),
    structuredOutputProviderOptions,
  );
  assert.equal(Reflect.get(session, "structuredOutputReasoning"), "high");
  assert.equal(Reflect.get(session, "compaction").timeoutMs, 120_000);
  assert.equal(Reflect.get(session, "compaction").maxOutputTokens, 8_192);
  await engine.dispose();
});

test("ConversationEngine 将 skillLibrary 目录注入 system prompt 并注册 skill 工具", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(...options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] } as const,
            { type: "text-start", id: "t" } as const,
            { type: "text-delta", id: "t", delta: "ok" } as const,
            { type: "text-end", id: "t" } as const,
            {
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: "stop" },
            } as const,
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const engine = new ConversationEngine({
    config,
    model,
    sources: [],
    skillLibrary: {
      list: () => [{ name: "demo-skill", description: "演示", source: "user" }],
      load: () => undefined,
      loadReference: () => undefined,
    },
  });

  const session = await engine.createSession();
  const consumed: unknown[] = [];
  for await (const event of session.send("hi")) {
    consumed.push(event);
  }
  assert.ok(consumed.length > 0);

  const system = captured.find((message) => message.role === "system");
  assert.ok(system);
  const content = String(system.content);
  assert.ok(content.includes("# Skills"));
  assert.ok(content.includes("demo-skill"));
  assert.ok(content.includes("roll__skill"));
  await engine.dispose();
});

test("ConversationEngine.getContextSummary 汇总 agent/tool/skill 数量", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const client = {} as never;
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({}),
    workspaceInstructions: null,
    sources: [
      {
        agentName: "a",
        client,
        tools: [
          {
            tool: { name: "t1", inputSchema: { type: "object" as const } },
            annotations: undefined,
          },
          {
            tool: { name: "t2", inputSchema: { type: "object" as const } },
            annotations: undefined,
          },
        ],
      },
    ],
    skillLibrary: {
      list: () => [{ name: "s1", description: "d", source: "user" }],
      load: () => undefined,
      loadReference: () => undefined,
    },
  });

  const summary = await engine.getContextSummary();
  assert.deepEqual(summary, { agentCount: 1, toolCount: 2, skillCount: 1 });
  await engine.dispose();
});

const STOP_REASON = { unified: "stop", raw: "stop" } as const;
const TOOL_CALLS_REASON = { unified: "tool-calls", raw: "tool-calls" } as const;

function mockUsage(inputTokens = 1, outputTokens = 1) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
}

function toolThenDoneModel(toolName: string, input: unknown): MockLanguageModelV4 {
  const steps: LanguageModelV4StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName,
        input: JSON.stringify(input),
      },
      { type: "finish", usage: mockUsage(), finishReason: TOOL_CALLS_REASON },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "done" },
      { type: "text-end", id: "t" },
      { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
    ],
  ];
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function engineTextStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
  ];
}

function engineStreamErrorStep(message: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "error", error: message },
  ];
}

function engineToolCallStep(
  toolCallId: string,
  toolName: string,
  input: unknown,
  inputTokens = 1,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: mockUsage(inputTokens), finishReason: TOOL_CALLS_REASON },
  ];
}

function sequencedEngineModel(steps: readonly LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps.at(-1) ?? [];
      index += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function structuredCompactionEngineModel(
  steps: readonly LanguageModelV4StreamPart[][],
  draft: (options: LanguageModelV4CallOptions) => unknown,
  observeStreamCall?: (options: LanguageModelV4CallOptions) => void,
): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      observeStreamCall?.(options);
      const chunks = steps[index] ?? steps.at(-1) ?? [];
      index += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
    doGenerate: async (options) => ({
      content: [{ type: "text", text: JSON.stringify(draft(options)) }],
      finishReason: STOP_REASON,
      usage: mockUsage(),
      warnings: [],
    }),
  });
}

function opaqueEvidenceIds(options: LanguageModelV4CallOptions): readonly string[] {
  return [
    ...new Set(
      [...JSON.stringify(options.prompt).matchAll(/evidence_[0-9a-f]{24}/gu)].map(
        (match) => match[0],
      ),
    ),
  ];
}

function nestedStrings(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(nestedStrings);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.values(value).flatMap(nestedStrings);
}

function structuredCompactionEvidence(options: LanguageModelV4CallOptions): readonly {
  readonly evidenceId: string;
  readonly summary: string;
  readonly outcome?: string;
}[] {
  const prompt = nestedStrings(options.prompt).find((value) =>
    value.includes("<harness-evidence>"),
  );
  assert.ok(prompt);
  const match = /<harness-evidence>\n([\s\S]+)\n<\/harness-evidence>/u.exec(prompt);
  assert.ok(match?.[1]);
  const parsed = JSON.parse(match[1]) as {
    readonly evidence: readonly {
      readonly evidenceId: string;
      readonly summary: string;
      readonly outcome?: string;
    }[];
  };
  return parsed.evidence;
}

test("ConversationEngine resourceHints 对 partial-invalid 整体回退，并规范化 field", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const agent: RegisteredAgent = {
    skill: { name: "resource-agent", description: "resource", metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    installPath: "/tmp/resource-agent",
    registeredAt: "2026-07-17T00:00:00.000Z",
    status: "idle",
  };
  const listedTool = (name: string) => ({
    name,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        conversationId: { type: "string" },
      },
      required: ["path", "conversationId"],
    },
    annotations: { destructiveHint: true },
    _meta: {
      "roll/resourceHints": [
        { field: "path", kind: "file", mode: "write" },
        name === "left"
          ? { field: "conversationId", kind: "custom", mode: "write" }
          : { field: "", kind: "conversation", mode: "write" },
      ],
    },
  });
  let active = 0;
  let maxActive = 0;
  const clientManager = {
    connect: async () => ({
      listTools: async () => ({ tools: [listedTool("left"), listedTool("right")] }),
      callTool: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const issues: AgentBootstrapIssue[] = [];
  const model = sequencedEngineModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "left-call",
        toolName: "resource-agent__left",
        input: JSON.stringify({ path: "left.txt", conversationId: "shared" }),
      },
      {
        type: "tool-call",
        toolCallId: "right-call",
        toolName: "resource-agent__right",
        input: JSON.stringify({ path: "right.txt", conversationId: "shared" }),
      },
      { type: "finish", usage: mockUsage(), finishReason: TOOL_CALLS_REASON },
    ],
    engineTextStep("done"),
  ]);
  const engine = new ConversationEngine({
    config,
    model,
    agents: [agent],
    skillLibrary: null,
    clientManager,
    ensureAgentReady: async () => {},
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });

  const session = await engine.createSession();
  await drain(session.send("run partial-invalid batch"));

  assert.equal(maxActive, 1);
  assert.equal(issues.length, 2);
  for (const issue of issues) {
    assert.equal(issue.agentName, "resource-agent");
    assert.match(issue.message, /roll\/resourceHints 无效.*已回退 Agent 级资源锁/u);
  }
  await engine.dispose();

  let trimmedActive = 0;
  let trimmedMaxActive = 0;
  const trimmedIssues: AgentBootstrapIssue[] = [];
  const trimmedClientManager = {
    connect: async () => ({
      listTools: async () => ({
        tools: ["left", "right"].map((name) => ({
          name,
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              conversationId: { type: "string" },
            },
            required: ["path", "conversationId"],
          },
          annotations: { destructiveHint: true },
          _meta: {
            "roll/resourceHints": [
              { field: " path ", kind: "file", mode: "write" },
              { field: "conversationId", kind: "conversation", mode: "write" },
            ],
          },
        })),
      }),
      callTool: async () => {
        trimmedActive += 1;
        trimmedMaxActive = Math.max(trimmedMaxActive, trimmedActive);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        trimmedActive -= 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const trimmedModel = sequencedEngineModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "trimmed-left",
        toolName: "resource-agent__left",
        input: JSON.stringify({ path: "shared.txt", conversationId: "left" }),
      },
      {
        type: "tool-call",
        toolCallId: "trimmed-right",
        toolName: "resource-agent__right",
        input: JSON.stringify({ path: "shared.txt", conversationId: "right" }),
      },
      { type: "finish", usage: mockUsage(), finishReason: TOOL_CALLS_REASON },
    ],
    engineTextStep("done"),
  ]);
  const trimmedEngine = new ConversationEngine({
    config,
    model: trimmedModel,
    agents: [agent],
    skillLibrary: null,
    clientManager: trimmedClientManager,
    ensureAgentReady: async () => {},
    onAgentBootstrapIssue: (issue) => trimmedIssues.push(issue),
  });

  const trimmedSession = await trimmedEngine.createSession();
  await drain(trimmedSession.send("run trimmed field batch"));

  assert.equal(trimmedMaxActive, 1);
  assert.deepEqual(trimmedIssues, []);
  await trimmedEngine.dispose();
});

function textModelCapture(capture: (options: LanguageModelV4CallOptions) => void) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      capture(options);
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "resumed" },
            { type: "text-end", id: "t" },
            { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

test("ConversationEngine context overflow 重放后仅持久化一组当前 Turn", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    let modelCalls = 0;
    const steps = [
      engineStreamErrorStep("context_length_exceeded: prompt is too long"),
      engineTextStep("overflow recovered exactly once"),
    ];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const chunks = steps[modelCalls] ?? steps.at(-1) ?? [];
        modelCalls += 1;
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "older turn" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "recent turn" },
      { role: "assistant", content: "recent answer" },
    ]);
    const engine = new ConversationEngine({
      config,
      model,
      store,
      sources: [],
      skillLibrary: null,
    });

    const session = await engine.resumeSession(threadId);
    const events: SessionEvent[] = [];
    for await (const event of session.send("overflow current turn")) {
      events.push(event);
    }

    assert.equal(modelCalls, 2);
    assert.equal(events.filter((event) => event.type === "message-start").length, 1);
    assert.equal(events.filter((event) => event.type === "context-compacted").length, 1);
    assert.equal(events.filter((event) => event.type === "message-finish").length, 1);
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );

    const activeMessages = store.getMessages(threadId);
    assert.equal(
      activeMessages.filter(
        (message) => message.role === "user" && message.content === "overflow current turn",
      ).length,
      1,
    );
    assert.equal(
      activeMessages.filter(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes("overflow recovered exactly once"),
      ).length,
      1,
    );
    const transcript = store.listTranscriptMessages(threadId);
    assert.equal(
      transcript.filter(
        (entry) =>
          entry.message.role === "user" && entry.message.content === "overflow current turn",
      ).length,
      1,
    );
    assert.equal(
      transcript.filter(
        (entry) =>
          entry.message.role === "assistant" &&
          JSON.stringify(entry.message.content).includes("overflow recovered exactly once"),
      ).length,
      1,
    );

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 将 ToolExecutionRecord 持久化并可跨进程恢复", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: toolThenDoneModel("probe__inspect", { path: "secret.txt" }),
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({
              content: [{ type: "text", text: "ok" }],
              structuredContent: { inspected: true },
              _meta: { trace: "kept-in-raw-ledger" },
            }),
          } as never,
          resourceBaseDir: process.cwd(),
          tools: [
            {
              tool: {
                name: "inspect",
                inputSchema: {
                  type: "object" as const,
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
              annotations: { readOnlyHint: true },
              resourceHints: [{ field: "path", kind: "file" }],
            },
          ],
        },
      ],
      skillLibrary: null,
    });

    const session = await engine.createSession();
    // Drain the full Tool loop so the ledger write and assistant response both settle.
    await drain(session.send("inspect"));
    const [record] = store.listToolExecutions(session.id);
    assert.equal(record?.outcome.kind, "success");
    assert.deepEqual(record?.input.value, { path: "secret.txt" });
    const persistedRecordJson = JSON.stringify(record);
    assert.doesNotMatch(persistedRecordJson, /kept-in-raw-ledger/u);
    assert.match(persistedRecordJson, /\[redacted\]/u);
    assert.equal(record?.persistence?.version, 1);
    assert.equal(record?.persistence?.fields.raw.redactionApplied, true);
    assert.match(JSON.stringify(record?.model), /ok/u);
    assert.match(JSON.stringify(record?.display), /ok/u);

    // Add a second completed turn so manual compaction has an older prefix to archive.
    await drain(session.send("second turn"));
    // Drain the atomic checkpoint commit.
    await drain(session.compact("manual"));
    const checkpoint = store.getLatestCheckpoint(session.id);
    assert.ok(checkpoint);
    assert.ok(
      checkpoint.resources.some(
        (resource) =>
          resource.key === `file:${resolve(process.cwd(), "secret.txt")}` &&
          resource.evidenceExecutionId === record?.id,
      ),
    );
    assert.equal(checkpoint.toolState.countsByOutcome.success, 1);
    assert.deepEqual(checkpoint.toolState.anomalies, []);
    assert.equal(checkpoint.toolState.integrityStatus, "valid");

    await engine.dispose();
    store.close();
    const reopened = new ThreadStore(dir);
    assert.equal(reopened.listToolExecutions(session.id)[0]?.id, record?.id);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine ledger 已提交但 transcript 失败时在下一次推理前原子恢复并 fail closed", async () => {
  const dir = tempDir();
  let database: DatabaseSync | undefined;
  let store: ThreadStore | undefined;
  let engine: ConversationEngine | undefined;
  try {
    const config = installEngineConfig("/tmp/roll-engine-ledger-gap");
    const prompts: LanguageModelV4CallOptions[] = [];
    const steps = [
      engineToolCallStep("c1", "probe__write", { q: "once" }),
      engineTextStep("first turn would finish"),
      engineTextStep("recovered safely"),
    ];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options);
        const chunks = steps[prompts.length - 1] ?? steps.at(-1) ?? [];
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    let toolCalls = 0;
    store = new ThreadStore(dir);
    engine = new ConversationEngine({
      config,
      model,
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => {
              toolCalls += 1;
              return { content: [{ type: "text", text: "side-effect-complete" }] };
            },
          } as never,
          tools: [
            {
              tool: {
                name: "write",
                inputSchema: {
                  type: "object" as const,
                  properties: { q: { type: "string" } },
                  required: ["q"],
                },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });
    const session = await engine.createSession();
    database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_turn_transcript
      BEFORE INSERT ON transcript_messages
      BEGIN
        SELECT RAISE(ABORT, 'simulated transcript commit failure');
      END;
    `);

    const failedEvents: SessionEvent[] = [];
    for await (const event of session.send("write once")) {
      failedEvents.push(event);
    }
    assert.equal(failedEvents.at(-1)?.type, "error");
    assert.equal(toolCalls, 1);
    assert.equal(prompts.length, 2);
    assert.equal(store.listUncoveredToolExecutions(session.id).length, 1);
    assert.deepEqual(store.getMessages(session.id), []);

    const blockedEvents: SessionEvent[] = [];
    for await (const event of session.send("continue while storage is broken")) {
      blockedEvents.push(event);
    }
    assert.equal(blockedEvents.at(-1)?.type, "error");
    assert.match(
      blockedEvents.find((event) => event.type === "error")?.message ?? "",
      /工具执行恢复状态持久化失败/u,
    );
    assert.equal(prompts.length, 2, "recovery persistence failure must block the provider");
    assert.equal(toolCalls, 1);
    assert.equal(store.listUncoveredToolExecutions(session.id).length, 1);

    database.exec("DROP TRIGGER reject_turn_transcript;");
    const recoveredEvents: SessionEvent[] = [];
    for await (const event of session.send("continue after storage recovery")) {
      recoveredEvents.push(event);
    }
    assert.equal(recoveredEvents.at(-1)?.type, "message-finish");
    assert.equal(prompts.length, 3);
    assert.equal(toolCalls, 1);
    assert.deepEqual(store.listUncoveredToolExecutions(session.id), []);
    const recoveredPrompt = JSON.stringify(prompts.at(-1)?.prompt);
    assert.match(recoveredPrompt, /roll__interrupted_turn_recovery/u);
    assert.match(recoveredPrompt, /side-effect-complete/u);
    assert.match(recoveredPrompt, /outcome.*kind.*success/u);

    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;
  } finally {
    await engine?.dispose();
    store?.close();
    database?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 续跑 segment 提交失败时只恢复新 execution,不重复已覆盖步骤", async () => {
  const dir = tempDir();
  let database: DatabaseSync | undefined;
  let store: ThreadStore | undefined;
  let engine: ConversationEngine | undefined;
  try {
    const baseConfig = installEngineConfig("/tmp/roll-engine-continuation-gap");
    const config = {
      ...baseConfig,
      runtime: {
        ...baseConfig.runtime,
        contextWindow: 200,
        compaction: {
          ...baseConfig.runtime.compaction,
          enabled: true,
          strategy: "truncate" as const,
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    };
    const prompts: LanguageModelV4CallOptions[] = [];
    const steps = [
      engineToolCallStep("c1", "probe__write", { q: "first" }, 170),
      engineToolCallStep("c2", "probe__write", { q: "second" }),
      engineTextStep("continuation done"),
      engineTextStep("after recovery"),
    ];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options);
        const chunks = steps[prompts.length - 1] ?? steps.at(-1) ?? [];
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    let toolCalls = 0;
    store = new ThreadStore(dir);
    const threadId = store.createThread({ model: "default-model" });
    store.appendMessages(threadId, [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ]);
    engine = new ConversationEngine({
      config,
      model,
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => {
              toolCalls += 1;
              return { content: [{ type: "text", text: `result-${String(toolCalls)}` }] };
            },
          } as never,
          tools: [
            {
              tool: {
                name: "write",
                inputSchema: {
                  type: "object" as const,
                  properties: { q: { type: "string" } },
                  required: ["q"],
                },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });
    const session = await engine.resumeSession(threadId);
    database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_c2_transcript
      BEFORE INSERT ON transcript_messages
      WHEN NEW.message_json LIKE '%"toolCallId":"c2"%'
      BEGIN
        SELECT RAISE(ABORT, 'simulated continuation transcript failure');
      END;
    `);

    const failedEvents: SessionEvent[] = [];
    for await (const event of session.send("tool loop")) {
      failedEvents.push(event);
    }
    assert.equal(failedEvents.at(-1)?.type, "error");
    assert.equal(toolCalls, 2);
    assert.equal(prompts.length, 3);
    const ledger = store.listToolExecutions(threadId);
    assert.deepEqual(
      ledger.map((record) => record.toolCallId),
      ["c1", "c2"],
    );
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((record) => record.id),
      [ledger[1]?.id],
    );

    const recoveredEvents: SessionEvent[] = [];
    for await (const event of session.send("continue safely")) {
      recoveredEvents.push(event);
    }
    assert.equal(recoveredEvents.at(-1)?.type, "message-finish");
    assert.equal(toolCalls, 2);
    assert.equal(prompts.length, 4);
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    const recoveredPrompt = JSON.stringify(prompts.at(-1)?.prompt);
    assert.match(recoveredPrompt, /result-2/u);
    assert.match(recoveredPrompt, /roll__interrupted_turn_recovery/u);
    assert.equal(recoveredPrompt.match(/result-2/gu)?.length ?? 0, 1);

    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;
  } finally {
    await engine?.dispose();
    store?.close();
    database?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 重启恢复仅投影未覆盖的 exact execution 且连续 resume 幂等", async () => {
  const dir = tempDir();
  let engine: ConversationEngine | undefined;
  let store: ThreadStore | undefined;
  try {
    const config = installEngineConfig("/tmp/roll-engine-ledger-resume");
    store = new ThreadStore(dir);
    const threadId = store.createThread({ model: "default-model" });
    const first = createToolExecutionRecord({
      id: "0905d35a-78a7-4485-9abc-d60c744c2a38",
      toolCallId: "shared-call",
      agentName: "probe",
      toolName: "write",
      input: { q: "first" },
      result: successfulToolResult("first-result"),
    });
    const second = createToolExecutionRecord({
      id: "51c5ef8f-cb7c-4dd6-ab87-90d029022bc0",
      toolCallId: "shared-call",
      agentName: "probe",
      toolName: "write",
      input: { q: "second" },
      result: successfulToolResult("second-result"),
    });
    store.appendToolExecution(threadId, first);
    store.appendMessages(threadId, [{ role: "assistant", content: "first already covered" }], {
      toolExecutionCoverage: {
        executionIds: [first.id],
        representation: "recovery_evidence",
      },
    });
    store.appendToolExecution(threadId, second);
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((record) => record.id),
      [second.id],
    );
    store.close();
    store = undefined;

    const prompts: LanguageModelV4CallOptions[] = [];
    store = new ThreadStore(dir);
    engine = new ConversationEngine({
      config,
      store,
      model: textModelCapture((options) => prompts.push(options)),
      sources: [],
      skillLibrary: null,
    });
    const resumed = await engine.resumeSession(threadId);
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    const recoveredBeforeInference = JSON.stringify(store.getMessages(threadId));
    assert.equal(recoveredBeforeInference.match(/cancelledTurnRecovery/gu)?.length ?? 0, 1);
    await drain(resumed.send("continue"));
    const prompt = JSON.stringify(prompts.at(-1)?.prompt);
    assert.match(prompt, /second-result/u);
    assert.doesNotMatch(prompt, /first-result/u);
    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;

    store = new ThreadStore(dir);
    engine = new ConversationEngine({
      config,
      store,
      model: textModelCapture(() => {}),
      sources: [],
      skillLibrary: null,
    });
    await engine.resumeSession(threadId);
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    assert.equal(
      JSON.stringify(store.getMessages(threadId)).match(/cancelledTurnRecovery/gu)?.length ?? 0,
      1,
    );
    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;
  } finally {
    await engine?.dispose();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 原子提交 checkpoint，并在 resume 时注入受控 transcript 入口", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "old-goal" },
      { role: "assistant", content: "old-answer" },
      { role: "user", content: "current-goal" },
      { role: "assistant", content: "current-answer" },
    ]);
    let capturedPrompt = "";
    const engine = new ConversationEngine({
      config,
      model: textModelCapture((options) => {
        capturedPrompt = JSON.stringify(options.prompt);
      }),
      store,
      sources: [],
      skillLibrary: null,
    });

    const session = await engine.resumeSession(threadId);
    const compactedEvents: SessionEvent[] = [];
    for await (const event of session.compact("manual")) {
      compactedEvents.push(event);
    }
    const checkpoint = store.getLatestCheckpoint(threadId);
    assert.ok(checkpoint);
    assert.equal(checkpoint.goal?.verbatimRequest, "current-goal");
    assert.deepEqual(checkpoint.constraints, []);
    assert.equal(checkpoint.transcript.completeness, "complete");
    assert.deepEqual(checkpoint.transcript.messages, {
      fromSequenceExclusive: -1,
      throughSequence: 3,
    });
    assert.deepEqual(checkpoint.transcript.toolExecutions, {
      fromSequenceExclusive: -1,
      throughSequence: -1,
    });
    assert.deepEqual(checkpoint.version === 2 ? checkpoint.semanticEvidence : undefined, {
      messagesThroughSequence: 3,
      toolExecutionsThroughSequence: -1,
    });
    assert.deepEqual(store.getMessages(threadId), [
      { role: "user", content: "current-goal" },
      { role: "assistant", content: "current-answer" },
    ]);
    const compacted = compactedEvents.find((event) => event.type === "context-compacted");
    assert.ok(compacted && compacted.type === "context-compacted");
    assert.equal(compacted.checkpointId, checkpoint.id);
    assert.equal(compacted.checkpointGeneration, 1);
    assert.equal(compacted.checkpointSummaryStatus, "skipped");
    assert.ok(
      session.getCapabilityManifest().tools.some((tool) => tool.role === "transcript-read"),
    );
    assert.equal(
      store.readCheckpointTranscript(threadId, {
        checkpointId: checkpoint.id,
        kind: "message",
        limit: 1,
      }).entries[0]?.sequence,
      0,
    );

    await session.close();
    const resumed = await engine.resumeSession(threadId);
    // Drain the turn so the model call captures the reconstructed reminder.
    await drain(resumed.send("continue"));
    assert.match(capturedPrompt, new RegExp(checkpoint.id, "u"));
    assert.match(capturedPrompt, /roll__transcript/u);
    assert.match(
      capturedPrompt,
      /Unclassified evidence: message 0 user: old-goal/u,
      "未分类的旧用户证据必须显式保留，而不是在 truncate 中静默消失",
    );

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 从持久化 V1 checkpoint 恢复时只用 watermark 后证据驱动下一次裁剪", async () => {
  const dir = tempDir();
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    runtime: {
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1,
      },
    },
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  try {
    const initialStore = new ThreadStore(dir);
    const threadId = initialStore.createThread();
    const archivedHistory = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0
        ? ({ role: "user", content: `archived-user-${String(index)}` } as const)
        : ({ role: "assistant", content: `archived-assistant-${String(index)}` } as const),
    );
    initialStore.appendMessages(threadId, archivedHistory);
    const seeded = initialStore.commitCompaction(threadId, {
      messages: archivedHistory.slice(-2),
      expectedActiveMessages: archivedHistory,
      expectedLatestCheckpointId: undefined,
      draft: {
        constraints: [],
        resources: [],
        toolState: createEmptyCompactionToolState(),
        runningWork: [],
        context: {
          cwd: process.cwd(),
          stableRuleIds: [],
          skills: [],
          explicitSkillNames: [],
        },
        summary: { status: "skipped" },
      },
      semanticState: createEmptyCompactionSemanticState(),
      semanticEvidenceWatermarks: {
        messagesThroughSequence: 39,
        toolExecutionsThroughSequence: -1,
      },
      evidenceWatermarks: {
        transcriptMessagesThroughSequence: 39,
        toolExecutionsThroughSequence: -1,
      },
    });
    const legacyMarker = "LEGACY_PENDING_KEEP_ME";
    const legacySecret = "legacy-super-secret";
    const legacySummaryPrefix =
      "以下摘要由另一个语言模型在压缩早前对话后产出。请据此继续推进、避免重复已完成的工作:";
    initialStore.replaceMessages(threadId, [
      {
        role: "user",
        content: `${legacySummaryPrefix}\n\n${legacyMarker}\nAWS_SECRET_ACCESS_KEY=${legacySecret}`,
      },
      { role: "assistant", content: "好的,我已读取之前工作的交接摘要,继续推进。" },
      ...archivedHistory.slice(-2),
    ]);
    initialStore.close();

    const legacyCheckpoint = {
      version: 1,
      id: seeded.id,
      generation: seeded.generation,
      createdAt: seeded.createdAt,
      transcript: seeded.transcript,
      goal: seeded.goal,
      constraints: seeded.constraints,
      resources: seeded.resources,
      toolState: seeded.toolState,
      runningWork: seeded.runningWork,
      context: seeded.context,
      summary: seeded.summary,
    };
    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        `UPDATE compaction_checkpoints
            SET schema_version = 1, checkpoint_json = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(legacyCheckpoint), seeded.id);
    database.close();

    const store = new ThreadStore(dir);
    store.appendMessages(threadId, [
      { role: "user", content: "current-after-v1" },
      { role: "assistant", content: "current-after-v1-answer" },
    ]);
    let semanticPrompt = "";
    let recoveryPrompt = "";
    const model = structuredCompactionEngineModel(
      [engineTextStep("migration-continued")],
      (options) => {
        semanticPrompt = JSON.stringify(options.prompt);
        const evidenceIds = opaqueEvidenceIds(options);
        return {
          startsNewGoalScope: false,
          goal: null,
          constraints: [],
          decisions: [],
          completedWork: [],
          pendingWork: [],
          resources: [],
          runningSessions: [],
          uncertainties: [],
          resolutions: [],
          evidenceReviews: evidenceIds.map((evidenceId) => ({
            evidenceId,
            disposition: "irrelevant",
            reason: "watermark regression fixture",
          })),
        };
      },
      (options) => {
        recoveryPrompt = JSON.stringify(options.prompt);
      },
    );
    const engine = new ConversationEngine({
      config,
      model,
      store,
      sources: [],
      skillLibrary: null,
    });
    const session = await engine.resumeSession(threadId);
    const events: SessionEvent[] = [];
    for await (const event of session.compact("manual")) {
      events.push(event);
    }

    assert.match(semanticPrompt, /message 40 user: current-after-v1/u);
    assert.match(semanticPrompt, /message 41 assistant: current-after-v1-answer/u);
    assert.match(semanticPrompt, new RegExp(legacyMarker, "u"));
    assert.doesNotMatch(semanticPrompt, /message 0 user: archived-user-0/u);
    assert.equal(events.find((event) => event.type === "context-compacted")?.removed, 4);
    const checkpoint = store.getLatestCheckpoint(threadId);
    assert.ok(checkpoint);
    assert.equal(checkpoint.version, 2);
    if (checkpoint.version !== 2) {
      assert.fail("expected V2 checkpoint after V1 recovery");
    }
    assert.equal(checkpoint.previousCheckpointId, seeded.id);
    assert.equal(checkpoint.semanticEvidence.messagesThroughSequence, 41);
    assert.ok(checkpoint.transcript.messages.throughSequence > 41);
    assert.equal(checkpoint.semanticEvidence.toolExecutionsThroughSequence, -1);
    assert.equal(
      checkpoint.semanticState.uncertainties.some(
        (item) =>
          item.sourceQuotes.some((quote) => quote.includes(legacyMarker)) &&
          item.provenance.every((reference) => reference.kind === "legacy_snapshot"),
      ),
      true,
    );
    assert.equal(checkpoint.semanticState.goal?.text.includes(legacyMarker) ?? false, false);
    assert.equal(
      [
        ...checkpoint.semanticState.constraints,
        ...checkpoint.semanticState.decisions,
        ...checkpoint.semanticState.completedWork,
        ...checkpoint.semanticState.pendingWork,
      ].some((item) => item.text.includes(legacyMarker)),
      false,
    );
    assert.deepEqual(store.getMessages(threadId), [
      { role: "user", content: "current-after-v1" },
      { role: "assistant", content: "current-after-v1-answer" },
    ]);
    await drain(session.send("continue-after-v1-migration"));
    assert.match(recoveryPrompt, new RegExp(legacyMarker, "u"));

    const archivedLegacyEntries = store
      .listTranscriptMessages(threadId, { limit: 500 })
      .filter((entry) => entry.provenance === "legacy_snapshot");
    assert.ok(archivedLegacyEntries.length > 0);
    assert.match(JSON.stringify(archivedLegacyEntries), new RegExp(legacyMarker, "u"));
    assert.doesNotMatch(JSON.stringify(archivedLegacyEntries), new RegExp(legacySecret, "u"));

    await engine.dispose();
    store.close();

    const denseStore = new ThreadStore(dir);
    denseStore.appendMessages(
      threadId,
      Array.from({ length: 96 }, (_, index) => ({
        role: "user" as const,
        content: `must preserve dense constraint ${String(index)} ${"x".repeat(360)}`,
      })),
    );
    let denseRecoveryPrompt = "";
    const denseEngine = new ConversationEngine({
      config,
      model: structuredCompactionEngineModel(
        [engineTextStep("dense-compaction-continued")],
        (options) => {
          const evidence = structuredCompactionEvidence(options);
          return {
            startsNewGoalScope: false,
            goal: null,
            constraints: [],
            decisions: [],
            completedWork: [],
            pendingWork: [],
            resources: [],
            runningSessions: [],
            uncertainties: evidence.map((entry) => ({
              priorItemId: null,
              text: entry.summary,
              sourceEvidenceIds: [entry.evidenceId],
              sourceQuotes: [entry.summary],
            })),
            resolutions: [],
            evidenceReviews: [],
          };
        },
        (options) => {
          denseRecoveryPrompt = JSON.stringify(options.prompt);
        },
      ),
      store: denseStore,
      sources: [],
      skillLibrary: null,
    });
    const denseSession = await denseEngine.resumeSession(threadId);
    for (let round = 0; round < 3; round += 1) {
      await drain(denseSession.compact("manual"));
    }
    const denseCheckpoint = denseStore.getLatestCheckpoint(threadId);
    assert.ok(denseCheckpoint);
    assert.equal(denseCheckpoint.version, 2);
    await drain(denseSession.send("verify dense recovery"));
    assert.doesNotMatch(
      denseRecoveryPrompt,
      new RegExp(legacyMarker, "u"),
      "fixture must evict the legacy marker from the bounded reminder",
    );

    let checkpointId: string | undefined = denseCheckpoint.id;
    let archivedMarkerFound = false;
    const visitedCheckpointIds = new Set<string>();
    while (checkpointId !== undefined && !visitedCheckpointIds.has(checkpointId)) {
      visitedCheckpointIds.add(checkpointId);
      let afterSequence: number | undefined;
      let previousCheckpointId: string | undefined;
      while (true) {
        const page = denseStore.readCheckpointTranscript(threadId, {
          checkpointId,
          kind: "message",
          ...(afterSequence !== undefined ? { afterSequence } : {}),
          limit: 20,
        });
        previousCheckpointId = page.previousCheckpointId;
        archivedMarkerFound ||= JSON.stringify(page.entries).includes(legacyMarker);
        if (page.nextAfterSequence === undefined) {
          break;
        }
        afterSequence = page.nextAfterSequence;
      }
      checkpointId = previousCheckpointId;
    }
    assert.equal(archivedMarkerFound, true);
    assert.equal(
      denseStore
        .listTranscriptMessages(threadId, { limit: 500 })
        .filter((entry) => entry.provenance === "legacy_snapshot").length,
      archivedLegacyEntries.length,
      "later V2 compaction must not duplicate the one-time V1 archive",
    );

    await denseEngine.dispose();
    denseStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 无法在 reminder 完整投影 V1 snapshot 时保留原 checkpoint 与消息", async () => {
  const dir = tempDir();
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    runtime: {
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1,
      },
    },
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  try {
    const initialStore = new ThreadStore(dir);
    const threadId = initialStore.createThread();
    const archivedHistory = [
      { role: "user", content: "legacy-goal" },
      { role: "assistant", content: "legacy-answer" },
    ] as const;
    initialStore.appendMessages(threadId, archivedHistory);
    const seeded = initialStore.commitCompaction(threadId, {
      messages: archivedHistory,
      expectedActiveMessages: archivedHistory,
      expectedLatestCheckpointId: undefined,
      draft: {
        constraints: [],
        resources: [],
        toolState: createEmptyCompactionToolState(),
        runningWork: [],
        context: {
          cwd: process.cwd(),
          stableRuleIds: [],
          skills: [],
          explicitSkillNames: [],
        },
        summary: { status: "skipped" },
      },
      semanticState: createEmptyCompactionSemanticState(),
      semanticEvidenceWatermarks: {
        messagesThroughSequence: 1,
        toolExecutionsThroughSequence: -1,
      },
      evidenceWatermarks: {
        transcriptMessagesThroughSequence: 1,
        toolExecutionsThroughSequence: -1,
      },
    });
    const legacySummaryPrefix =
      "以下摘要由另一个语言模型在压缩早前对话后产出。请据此继续推进、避免重复已完成的工作:";
    const unmigratedMarker = "UNMIGRATED_REMINDER_MARKER";
    const oversizedLegacySummary = `${unmigratedMarker}${"x".repeat(512 * 50)}`;
    const activeMessages = [
      { role: "user", content: `${legacySummaryPrefix}\n\n${oversizedLegacySummary}` },
      { role: "assistant", content: "好的,我已读取之前工作的交接摘要,继续推进。" },
      ...archivedHistory,
    ] as const;
    initialStore.replaceMessages(threadId, activeMessages);
    initialStore.appendMessages(threadId, [
      { role: "user", content: "post-v1-turn" },
      { role: "assistant", content: "post-v1-answer" },
    ]);
    const legacyCheckpoint = {
      version: 1,
      id: seeded.id,
      generation: seeded.generation,
      createdAt: seeded.createdAt,
      transcript: seeded.transcript,
      goal: seeded.goal,
      constraints: seeded.constraints,
      resources: seeded.resources,
      toolState: seeded.toolState,
      runningWork: seeded.runningWork,
      context: seeded.context,
      summary: seeded.summary,
    };
    const database = new DatabaseSync(join(dir, "threads.db"));
    database
      .prepare(
        `UPDATE compaction_checkpoints
            SET schema_version = 1, checkpoint_json = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(legacyCheckpoint), seeded.id);
    database.close();
    initialStore.close();

    let draftCalls = 0;
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: structuredCompactionEngineModel([], () => {
        draftCalls += 1;
        return {
          startsNewGoalScope: false,
          goal: null,
          constraints: [],
          decisions: [],
          completedWork: [],
          pendingWork: [],
          resources: [],
          runningSessions: [],
          uncertainties: [],
          resolutions: [],
          evidenceReviews: [],
        };
      }),
      store,
      sources: [],
      skillLibrary: null,
    });
    const session = await engine.resumeSession(threadId);
    const events: SessionEvent[] = [];
    for await (const event of session.compact("manual")) {
      events.push(event);
    }

    assert.equal(draftCalls, 1);
    assert.equal(events.find((event) => event.type === "context-compacted")?.removed, 0);
    assert.equal(store.getLatestCheckpoint(threadId)?.version, 1);
    assert.equal(
      store
        .getMessages(threadId)
        .some(
          (message) =>
            typeof message.content === "string" && message.content.includes(unmigratedMarker),
        ),
      true,
    );

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 结构化 checkpoint 跨重启继承 pending，并单独保留成功 Tool evidence", async () => {
  const dir = tempDir();
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    runtime: {
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1,
      },
    },
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  try {
    const initialStore = new ThreadStore(dir);
    const initialModel = structuredCompactionEngineModel(
      [engineTextStep("开始实现"), engineTextStep("仍需验证")],
      (options) => {
        const [goalEvidence] = structuredCompactionEvidence(options);
        assert.ok(goalEvidence);
        return {
          startsNewGoalScope: false,
          goal: null,
          constraints: [],
          decisions: [],
          completedWork: [],
          pendingWork: [
            {
              priorItemId: null,
              text: "运行验证并确认结果",
              sourceEvidenceIds: [goalEvidence.evidenceId],
              sourceQuotes: [goalEvidence.summary],
            },
          ],
          resources: [],
          runningSessions: [],
          uncertainties: [],
          resolutions: [],
          evidenceReviews: [],
        };
      },
    );
    const initialEngine = new ConversationEngine({
      config,
      model: initialModel,
      store: initialStore,
      sources: [],
      skillLibrary: null,
    });
    const initialSession = await initialEngine.createSession();
    const threadId = initialSession.id;
    await drain(initialSession.send("实现结构化恢复"));
    await drain(initialSession.send("继续"));
    await drain(initialSession.compact("manual"));

    const firstCheckpoint = initialStore.getLatestCheckpoint(threadId);
    assert.ok(firstCheckpoint);
    assert.equal(firstCheckpoint.version, 2);
    if (firstCheckpoint.version !== 2) {
      assert.fail("expected V2 checkpoint");
    }
    assert.equal(firstCheckpoint.semanticState.pendingWork.length, 1);
    assert.equal(firstCheckpoint.semanticState.completedWork.length, 0);
    assert.ok(firstCheckpoint.semanticEvidence.messagesThroughSequence >= 1);
    const pendingItemId = firstCheckpoint.semanticState.pendingWork[0]?.id;
    assert.ok(pendingItemId);
    assert.equal(firstCheckpoint.summary.status, "valid");
    await initialEngine.dispose();
    initialStore.close();

    const resumedStore = new ThreadStore(dir);
    const resumedModel = structuredCompactionEngineModel(
      [engineToolCallStep("verify-call", "probe__verify", {}), engineTextStep("验证完成")],
      (options) => {
        const prompt = JSON.stringify(options.prompt);
        const evidence = structuredCompactionEvidence(options);
        const successEvidence = evidence.find((entry) => entry.outcome === "success");
        const previousPendingId = /semantic_pending_work_[0-9a-f]{24}/u.exec(prompt)?.[0];
        assert.ok(successEvidence);
        assert.ok(evidence.length > 0);
        assert.equal(previousPendingId, pendingItemId);
        return {
          startsNewGoalScope: false,
          goal: null,
          constraints: [],
          decisions: [],
          completedWork: [
            {
              priorItemId: null,
              text: "验证已成功完成",
              sourceEvidenceIds: [successEvidence.evidenceId],
              sourceQuotes: [successEvidence.summary],
            },
          ],
          pendingWork: [],
          resources: [],
          runningSessions: [],
          uncertainties: [],
          resolutions: [],
          evidenceReviews: [],
        };
      },
    );
    const resumedEngine = new ConversationEngine({
      config,
      model: resumedModel,
      store: resumedStore,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({ content: [{ type: "text", text: "verified" }] }),
          } as never,
          tools: [
            {
              tool: {
                name: "verify",
                inputSchema: { type: "object" as const, additionalProperties: false },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });
    const resumedSession = await resumedEngine.resumeSession(threadId);
    await drain(resumedSession.send("好的，继续"));
    await drain(resumedSession.compact("manual"));

    const secondCheckpoint = resumedStore.getLatestCheckpoint(threadId);
    assert.ok(secondCheckpoint);
    assert.equal(secondCheckpoint.version, 2);
    if (secondCheckpoint.version !== 2) {
      assert.fail("expected V2 checkpoint");
    }
    assert.equal(secondCheckpoint.previousCheckpointId, firstCheckpoint.id);
    assert.ok(
      secondCheckpoint.semanticEvidence.messagesThroughSequence >
        firstCheckpoint.semanticEvidence.messagesThroughSequence,
    );
    assert.ok(secondCheckpoint.semanticEvidence.toolExecutionsThroughSequence >= 0);
    assert.equal(
      secondCheckpoint.semanticState.pendingWork.length,
      1,
      "成功 Tool 事实不能在缺少任务级因果契约时自动删除 pending",
    );
    assert.equal(secondCheckpoint.semanticState.completedWork.length, 1);
    assert.match(
      secondCheckpoint.semanticState.completedWork[0]?.text ?? "",
      /Successful Tool evidence:.*verified/u,
    );
    assert.equal(
      secondCheckpoint.semanticState.completedWork[0]?.provenance.some(
        (reference) => reference.kind === "tool_execution",
      ),
      true,
    );
    const summaries = resumedStore
      .getMessages(threadId)
      .filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith(SUMMARY_PREFIX),
      );
    assert.equal(summaries.length, 0, "structured state is injected once via checkpoint reminder");

    await resumedEngine.dispose();
    resumedStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 连续 compaction/resume 继承硬约束，并由后续同 scope 显式允许撤销", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: sequencedEngineModel([
        engineTextStep("initial work done"),
        engineTextStep("continued once"),
        engineTextStep("continued twice"),
      ]),
      store,
      sources: [],
      skillLibrary: null,
    });

    const session = await engine.createSession();
    const threadId = session.id;
    await drain(session.send("修复调度器，但绝对不要修改公开 API"));
    await drain(session.send("继续"));
    await drain(session.compact("manual"));

    const first = store.getLatestCheckpoint(threadId);
    assert.ok(first);
    assert.equal(first.goal?.verbatimRequest, "修复调度器，但绝对不要修改公开 API");
    assert.deepEqual(first.constraints, [{ quote: "绝对不要修改公开 API", sourceSequence: 0 }]);

    await drain(session.send("继续处理"));
    await drain(session.compact("manual"));
    const second = store.getLatestCheckpoint(threadId);
    assert.ok(second);
    assert.equal(second.generation, 2);
    assert.equal(second.previousCheckpointId, first.id);
    assert.equal(second.goal?.verbatimRequest, "修复调度器，但绝对不要修改公开 API");
    assert.deepEqual(second.constraints, first.constraints);

    await engine.dispose();
    store.close();

    const reopenedStore = new ThreadStore(dir);
    const resumedPrompts: string[] = [];
    const reopenedEngine = new ConversationEngine({
      config,
      model: textModelCapture((options) => {
        resumedPrompts.push(JSON.stringify(options.prompt));
      }),
      store: reopenedStore,
      sources: [],
      skillLibrary: null,
    });
    const resumed = await reopenedEngine.resumeSession(threadId);
    await drain(resumed.send("继续"));

    assert.match(resumedPrompts[0] ?? "", /修复调度器，但绝对不要修改公开 API/u);
    assert.match(resumedPrompts[0] ?? "", /绝对不要修改公开 API/u);
    assert.match(resumedPrompts[0] ?? "", new RegExp(second.id, "u"));
    assert.deepEqual(reopenedStore.getLatestCheckpoint(threadId)?.constraints, [
      { quote: "绝对不要修改公开 API", sourceSequence: 0 },
    ]);

    await drain(resumed.send("现在允许修改公开 API"));
    await drain(resumed.compact("manual"));
    const third = reopenedStore.getLatestCheckpoint(threadId);
    assert.ok(third);
    assert.equal(third.generation, 3);
    assert.equal(third.previousCheckpointId, second.id);
    assert.equal(
      third.goal?.verbatimRequest,
      "修复调度器，但绝对不要修改公开 API",
      "同 scope 的约束变更不能把主目标替换成一条权限说明",
    );
    assert.deepEqual(third.constraints, []);

    await reopenedEngine.dispose();
    reopenedStore.close();

    const finalStore = new ThreadStore(dir);
    let finalPrompt = "";
    const finalEngine = new ConversationEngine({
      config,
      model: textModelCapture((options) => {
        finalPrompt = JSON.stringify(options.prompt);
      }),
      store: finalStore,
      sources: [],
      skillLibrary: null,
    });
    const finalSession = await finalEngine.resumeSession(threadId);
    await drain(finalSession.send("继续"));

    assert.match(finalPrompt, /现在允许修改公开 API/u);
    assert.match(finalPrompt, /semanticState 是 V2 恢复事实源/u);
    assert.match(finalPrompt, /\\"constraints\\":\[\]/u);
    assert.match(finalPrompt, new RegExp(third.id, "u"));
    assert.deepEqual(finalStore.getLatestCheckpoint(threadId)?.constraints, []);

    await finalEngine.dispose();
    finalStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine checkpoint Skill 绑定选中 goal，续接继承而普通新任务清空", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const reviewSkill = { name: "review", description: "审查", source: "project" } as const;
    const engine = new ConversationEngine({
      config,
      model: sequencedEngineModel([
        engineTextStep("reviewed"),
        engineTextStep("continued"),
        engineTextStep("continued politely"),
        engineTextStep("new task handled"),
      ]),
      store,
      sources: [],
      skillLibrary: {
        list: () => [reviewSkill],
        load: (name) =>
          name === reviewSkill.name
            ? { summary: reviewSkill, content: "Review carefully.", referencePaths: [] }
            : undefined,
        loadReference: () => undefined,
      },
    });

    const session = await engine.createSession();
    await drain(session.send("/review 旧任务"));
    await drain(session.send("继续"));
    await drain(session.compact("manual"));
    const first = store.getLatestCheckpoint(session.id);
    assert.ok(first);
    assert.equal(first.goal?.verbatimRequest, "旧任务");
    assert.deepEqual(first.context.explicitSkillNames, ["review"]);

    await drain(session.send("好的，继续吧"));
    await drain(session.compact("manual"));
    const second = store.getLatestCheckpoint(session.id);
    assert.ok(second);
    assert.equal(second.goal?.verbatimRequest, "旧任务");
    assert.deepEqual(second.context.explicitSkillNames, ["review"]);

    await drain(session.send("处理新的普通任务"));
    await drain(session.compact("manual"));
    const third = store.getLatestCheckpoint(session.id);
    assert.ok(third);
    assert.equal(third.goal?.verbatimRequest, "处理新的普通任务");
    assert.deepEqual(third.context.explicitSkillNames, []);

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 资源 checkpoint 按最近成功触达淘汰并保留 write evidence", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    const seededResources = Array.from({ length: 256 }, (_, index) => ({
      key: `fixture:${String(index)}`,
      mode: TOOL_RESOURCE_ACCESS_MODES.write,
      evidenceToolCallId: `seed-${String(index)}`,
      evidenceExecutionId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    }));
    store.commitCompaction(threadId, {
      messages: [],
      expectedActiveMessages: [],
      expectedLatestCheckpointId: undefined,
      draft: {
        constraints: [],
        resources: seededResources,
        toolState: createEmptyCompactionToolState(),
        runningWork: [],
        context: {
          cwd: process.cwd(),
          stableRuleIds: [],
          skills: [],
          explicitSkillNames: [],
        },
        summary: { status: "skipped" },
      },
      semanticState: createEmptyCompactionSemanticState(),
      semanticEvidenceWatermarks: {
        messagesThroughSequence: -1,
        toolExecutionsThroughSequence: -1,
      },
      evidenceWatermarks: {
        transcriptMessagesThroughSequence: -1,
        toolExecutionsThroughSequence: -1,
      },
    });
    const engine = new ConversationEngine({
      config,
      model: sequencedEngineModel([
        engineToolCallStep("call-new", "probe__touch", { resource: "256" }),
        engineTextStep("new touched"),
        engineToolCallStep("call-old-rewrite", "probe__touch", { resource: "0" }),
        engineTextStep("old rewritten"),
      ]),
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
          } as never,
          tools: [
            {
              tool: {
                name: "touch",
                inputSchema: {
                  type: "object" as const,
                  properties: { resource: { type: "string" } },
                  required: ["resource"],
                },
              },
              annotations: { readOnlyHint: true },
              resourceHints: [
                {
                  field: "resource",
                  kind: TOOL_RESOURCE_HINT_KINDS.custom,
                  namespace: "fixture",
                  mode: TOOL_RESOURCE_ACCESS_MODES.write,
                },
              ],
            },
          ],
        },
      ],
      skillLibrary: null,
    });

    const session = await engine.resumeSession(threadId);
    await drain(session.send("touch new resource"));
    await drain(session.send("rewrite oldest resource"));
    const rewritten = store
      .listToolExecutions(threadId)
      .find((record) => record.toolCallId === "call-old-rewrite");
    assert.ok(rewritten);
    await drain(session.compact("manual"));

    const checkpoint = store.getLatestCheckpoint(threadId);
    assert.ok(checkpoint);
    assert.equal(checkpoint.resources.length, 256);
    assert.deepEqual(
      checkpoint.resources.find((resource) => resource.key === "fixture:0"),
      {
        key: "fixture:0",
        mode: TOOL_RESOURCE_ACCESS_MODES.write,
        evidenceToolCallId: "call-old-rewrite",
        evidenceExecutionId: rewritten.id,
      },
    );
    assert.ok(checkpoint.resources.some((resource) => resource.key === "fixture:256"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 连续 AgentSession compaction 累计 typed Tool state", async () => {
  const dir = tempDir();
  try {
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const model = sequencedEngineModel([
      engineToolCallStep("call-first", "probe__inspect", { value: "first" }),
      engineTextStep("first done"),
      engineTextStep("first checkpoint boundary"),
      engineToolCallStep("call-second", "probe__inspect", { value: "second" }),
      engineTextStep("second done"),
      engineTextStep("second checkpoint boundary"),
    ]);
    const engine = new ConversationEngine({
      config,
      model,
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({ content: [{ type: "text", text: "inspected" }] }),
          } as never,
          tools: [
            {
              tool: {
                name: "inspect",
                inputSchema: {
                  type: "object" as const,
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });

    const session = await engine.createSession();
    await drain(session.send("inspect first"));
    await drain(session.send("checkpoint one"));
    await drain(session.compact("manual"));
    const first = store.getLatestCheckpoint(session.id);
    assert.ok(first);
    assert.equal(first.generation, 1);
    assert.equal(first.toolState.countsByOutcome.success, 1);
    assert.equal(first.toolState.integrityStatus, "valid");

    await drain(session.send("inspect second"));
    await drain(session.send("checkpoint two"));
    await drain(session.compact("manual"));
    const second = store.getLatestCheckpoint(session.id);
    assert.ok(second);
    assert.equal(second.generation, 2);
    assert.equal(second.previousCheckpointId, first.id);
    assert.equal(second.toolState.countsByOutcome.success, 2);
    assert.deepEqual(
      second.toolState.recentRecords.map((record) => record.toolCallId),
      ["call-first", "call-second"],
    );
    assert.deepEqual(second.toolState.anomalies, []);

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 截断 Tool Result 后仍可经 checkpoint transcript 回查原证据", async () => {
  const dir = tempDir();
  try {
    const evidenceMarker = "ORIGINAL_TOOL_EVIDENCE_20260717";
    const config = rollConfigSchema.parse({
      llm: {
        defaultProvider: "mock",
        defaultModel: "default-model",
        providers: { mock: { apiKey: "test" } },
      },
      ask: {},
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 8,
          keepRecentTokens: 100_000,
        },
      },
      agents: { dataDir: "/tmp/roll-engine-test" },
    });
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config,
      model: sequencedEngineModel([
        engineToolCallStep("call-large", "probe__large", {}),
        engineTextStep("large result observed"),
      ]),
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({
              content: [{ type: "text", text: `${evidenceMarker}:${"x".repeat(6_000)}` }],
            }),
          } as never,
          tools: [
            {
              tool: { name: "large", inputSchema: { type: "object" as const } },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });

    const session = await engine.createSession();
    await drain(session.send("read large result"));
    const compactEvents: SessionEvent[] = [];
    for await (const event of session.compact("manual")) {
      compactEvents.push(event);
    }
    const checkpoint = store.getLatestCheckpoint(session.id);
    assert.ok(checkpoint);
    const compacted = compactEvents.find((event) => event.type === "context-compacted");
    assert.ok(compacted && compacted.type === "context-compacted");
    assert.equal(compacted.truncatedTools, 1);
    assert.match(JSON.stringify(store.getMessages(session.id)), /已省略.*工具结果/u);
    assert.doesNotMatch(
      JSON.stringify(store.getMessages(session.id)),
      new RegExp(evidenceMarker, "u"),
    );

    const recovered = executeTranscriptTool(
      (options) => store.readCheckpointTranscript(session.id, options),
      { checkpointId: checkpoint.id, kind: "message", limit: 10 },
    );
    assert.equal(recovered.outcome.kind, "success");
    assert.match(JSON.stringify(recovered.raw), new RegExp(evidenceMarker, "u"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "ConversationEngine checkpoint 中的 live session 在新 manager resume 时降级为 stale",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const config = rollConfigSchema.parse({
        llm: {
          defaultProvider: "mock",
          defaultModel: "default-model",
          providers: { mock: { apiKey: "test" } },
        },
        ask: {},
        runtime: {
          compaction: {
            enabled: true,
            strategy: "truncate",
            threshold: 0.75,
            keepRecentTurns: 1,
            keepRecentTokens: 1,
          },
          shell: {
            enabled: true,
            autoApproveSafe: true,
            session: { enabled: true, defaultYieldMs: 250 },
          },
        },
        agents: { dataDir: "/tmp/roll-engine-test" },
      });
      const store = new ThreadStore(dir);
      const engine = new ConversationEngine({
        config,
        model: sequencedEngineModel([
          engineToolCallStep("call-live", "roll__exec_command", {
            command: "sleep 30",
            yield_time_ms: 250,
          }),
          engineTextStep("background started"),
          engineTextStep("checkpoint boundary"),
        ]),
        store,
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
        shellProfile: posixSessionProfile,
      });

      const session = await engine.createSession();
      await drain(session.send("start background work"));
      await drain(session.send("prepare checkpoint"));
      await drain(session.compact("manual"));
      const checkpoint = store.getLatestCheckpoint(session.id);
      assert.ok(checkpoint);
      const liveWork = checkpoint.runningWork.find((work) => work.recoverability === "live");
      assert.ok(liveWork);
      assert.equal(liveWork.state, "running");
      const threadId = session.id;
      await engine.dispose();

      let resumedPrompt = "";
      const reopened = new ConversationEngine({
        config,
        model: textModelCapture((options) => {
          resumedPrompt = JSON.stringify(options.prompt);
        }),
        store,
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
        shellProfile: posixSessionProfile,
      });
      const resumed = await reopened.resumeSession(threadId);
      await drain(resumed.send("recover background status"));
      assert.ok(resumedPrompt.includes(`\\"sessionId\\":${String(liveWork.sessionId)}`));
      assert.ok(resumedPrompt.includes('\\"managerMatch\\":\\"foreign\\"'));
      assert.ok(resumedPrompt.includes('\\"recoverability\\":\\"stale\\"'));

      await reopened.dispose();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("ConversationEngine 每 Turn 刷新 VCS context，而不重建稳定 capability manifest", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const prompts: string[] = [];
  let inspection = 0;
  let rulesResolution = 0;
  const engine = new ConversationEngine({
    config,
    model: textModelCapture((options) => prompts.push(JSON.stringify(options.prompt))),
    sources: [],
    skillLibrary: null,
    resolveDynamicCapabilityContext: (abortSignal) => {
      assert.equal(abortSignal.aborted, false);
      rulesResolution += 1;
      return { ruleIds: [`workspace/rules-v${String(rulesResolution)}`] };
    },
    inspectVcsContext: () => {
      inspection += 1;
      return inspection === 1
        ? { branch: "main", dirty: false }
        : { branch: "feature/checkpoint", dirty: true, ahead: 1 };
    },
  });

  const session = await engine.createSession();
  const stableManifest = JSON.stringify(session.getCapabilityManifest());
  await drain(session.send("first"));
  const first = session.getCapabilityTurnContext();
  await drain(session.send("second"));
  const second = session.getCapabilityTurnContext();

  assert.deepEqual(first?.dynamic.vcs, { branch: "main", dirty: false });
  assert.deepEqual(first?.dynamic.ruleIds, ["workspace/rules-v1"]);
  assert.deepEqual(second?.dynamic.vcs, {
    branch: "feature/checkpoint",
    dirty: true,
    ahead: 1,
  });
  assert.deepEqual(second?.dynamic.ruleIds, ["workspace/rules-v2"]);
  assert.equal(JSON.stringify(session.getCapabilityManifest()), stableManifest);
  assert.match(prompts[0] ?? "", /vcs=main;dirty=false/u);
  assert.match(prompts[0] ?? "", /ruleIds=workspace\/rules-v1/u);
  assert.match(prompts[1] ?? "", /vcs=feature\/checkpoint;dirty=true/u);
  assert.match(prompts[1] ?? "", /ruleIds=workspace\/rules-v2/u);

  await engine.dispose();
});

function bashEngineConfig(dataDir: string, autoApproveSafe: boolean) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    runtime: { shell: { enabled: true, autoApproveSafe } },
    agents: { dataDir },
  });
}

test(
  "autoApproveSafe=true 注入 ruleBasedClassifier：known-safe 命令免确认执行",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const engine = new ConversationEngine({
        config: bashEngineConfig(dir, true),
        model: toolThenDoneModel("roll__bash", { command: "pwd" }),
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("看下当前目录")) {
        events.push(event);
      }
      assert.ok(!events.some((event) => event.type === "confirmation-required"));
      const result = events.find((event) => event.type === "tool-result");
      assert.ok(result && result.type === "tool-result");
      assert.equal(result.isError, false);
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "autoApproveSafe=false 回归 unknownCommandClassifier：同一命令仍需确认",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const engine = new ConversationEngine({
        config: bashEngineConfig(dir, false),
        model: toolThenDoneModel("roll__bash", { command: "pwd" }),
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("看下当前目录")) {
        events.push(event);
        if (event.type === "confirmation-required") {
          session.reject(event.approvalId);
        }
      }
      assert.ok(events.some((event) => event.type === "confirmation-required"));
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("supportsSafeCommandClassification=false 的 profile 谎报 known-safe 也仍逐条确认", async () => {
  const dir = tempDir();
  try {
    const engine = new ConversationEngine({
      config: bashEngineConfig(dir, true),
      model: toolThenDoneModel("roll__powershell", { command: "Get-Location" }),
      sources: [],
      skillLibrary: null,
      policy: new DefaultToolPolicy(),
      shellProfile: { ...powershellProfile, classify: () => "known-safe" },
    });
    const session = await engine.createSession();
    const events = [];
    for await (const event of session.send("看下当前目录")) {
      events.push(event);
      if (event.type === "confirmation-required") {
        session.reject(event.approvalId);
      }
    }
    assert.ok(events.some((event) => event.type === "confirmation-required"));
    session.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function toolCapturingModel(capture: (names: string) => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (opts) => {
      capture(JSON.stringify(opts.tools ?? []));
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function sessionExecConfig(dataDir: string, autoApproveSafe = true) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    runtime: {
      shell: { enabled: true, autoApproveSafe, session: { enabled: true } },
    },
    agents: { dataDir },
  });
}

test(
  "session exec 默认沿用 profile classifier：create/resume 的 known-safe 命令均免确认",
  { skip: process.platform === "win32" },
  async () => {
    for (const lifecycle of ["create", "resume"] as const) {
      const dir = tempDir();
      const store = lifecycle === "resume" ? new ThreadStore(join(dir, "threads")) : undefined;
      const engine = new ConversationEngine({
        config: sessionExecConfig(dir),
        model: toolThenDoneModel("roll__exec_command", {
          command: "pwd",
          yield_time_ms: 250,
        }),
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
        ...(store ? { store } : {}),
      });
      try {
        let session;
        if (lifecycle === "create") {
          session = await engine.createSession();
        } else {
          assert.ok(store);
          session = await engine.resumeSession(store.createThread({ model: "default-model" }));
        }
        const events = [];
        for await (const event of session.send("看下当前目录")) {
          events.push(event);
        }
        assert.ok(
          !events.some((event) => event.type === "confirmation-required"),
          `${lifecycle} 不应要求确认`,
        );
        const result = events.find((event) => event.type === "tool-result");
        assert.ok(result && result.type === "tool-result");
        assert.equal(result.isError, false);
        session.abort();
      } finally {
        await engine.dispose();
        store?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  "session exec 关闭 autoApproveSafe 后 known-safe 命令仍需确认",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    const engine = new ConversationEngine({
      config: sessionExecConfig(dir, false),
      model: toolThenDoneModel("roll__exec_command", {
        command: "pwd",
        yield_time_ms: 250,
      }),
      sources: [],
      skillLibrary: null,
      policy: new DefaultToolPolicy(),
    });
    try {
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("看下当前目录")) {
        events.push(event);
        if (event.type === "confirmation-required") {
          session.reject(event.approvalId);
        }
      }
      assert.ok(events.some((event) => event.type === "confirmation-required"));
      session.abort();
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sessionExecEnabled=false（单轮模式）不注册 exec 工具，bash 仍在（P2）",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      let tools = "";
      const engine = new ConversationEngine({
        config: sessionExecConfig(dir),
        model: toolCapturingModel((names) => {
          tools = names;
        }),
        sources: [],
        skillLibrary: null,
        sessionExecEnabled: false,
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("hi")) {
        events.push(event);
      }
      assert.ok(events.length > 0);
      assert.ok(tools.includes("roll__bash"));
      assert.ok(!tools.includes("roll__exec_command"));
      assert.ok(!tools.includes("roll__exec_poll"));
      assert.ok(!tools.includes("roll__exec_list"));
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "默认（长驻模式）session.enabled 时注册 exec 工具（P2 对照）",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      let tools = "";
      const engine = new ConversationEngine({
        config: sessionExecConfig(dir),
        model: toolCapturingModel((names) => {
          tools = names;
        }),
        sources: [],
        skillLibrary: null,
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("hi")) {
        events.push(event);
      }
      assert.ok(events.length > 0);
      assert.ok(tools.includes("roll__exec_command"));
      assert.ok(tools.includes("roll__exec_poll"));
      assert.ok(tools.includes("roll__exec_list"));
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("PowerShell profile 注册 roll__powershell 与 session exec", async () => {
  const dir = tempDir();
  try {
    let tools = "";
    const engine = new ConversationEngine({
      config: sessionExecConfig(dir),
      model: toolCapturingModel((names) => {
        tools = names;
      }),
      sources: [],
      skillLibrary: null,
      shellProfile: powershellProfile,
    });
    const session = await engine.createSession();
    const events = [];
    for await (const event of session.send("hi")) {
      events.push(event);
    }
    assert.ok(events.length > 0);
    assert.ok(tools.includes("roll__powershell"));
    assert.ok(!tools.includes("roll__bash"));
    assert.ok(tools.includes("roll__exec_command"));
    assert.ok(tools.includes("roll__exec_poll"));
    assert.ok(tools.includes("roll__exec_list"));
    session.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行期 shell profile 探测在 engine 实例内缓存", async () => {
  const dir = tempDir();
  try {
    let calls = 0;
    const engine = new ConversationEngine({
      config: sessionExecConfig(dir),
      model: toolCapturingModel(() => {}),
      sources: [],
      skillLibrary: null,
      resolveShellProfileFn: () => {
        calls += 1;
        return { supported: true, profile: powershellProfile };
      },
    });
    const first = await engine.createSession();
    const second = await engine.createSession();
    assert.ok(first.id !== second.id);
    assert.equal(calls, 1);
    first.abort();
    second.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 使用隔离的 Chat shell 环境且不读取后续全局变更", async () => {
  const dir = tempDir();
  const shellEnv: NodeJS.ProcessEnv = {
    PATH: "/tmp/current-roll:/usr/bin",
    ROLL_CURRENT_CLI: "/tmp/current-roll/roll",
  };
  let observedEnv: Readonly<Record<string, string | undefined>> | undefined;
  try {
    const engine = new ConversationEngine({
      config: sessionExecConfig(dir),
      model: toolCapturingModel(() => {}),
      sources: [],
      skillLibrary: null,
      shellEnv,
      resolveShellProfileFn: ({ env }) => {
        observedEnv = env;
        return { supported: true, profile: powershellProfile };
      },
    });
    shellEnv.PATH = "/mutated-after-construction";

    const session = await engine.createSession();

    assert.equal(observedEnv?.PATH, "/tmp/current-roll:/usr/bin");
    assert.equal(observedEnv?.ROLL_CURRENT_CLI, "/tmp/current-roll/roll");
    assert.notEqual(observedEnv, shellEnv);
    session.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "不支持的 PowerShell profile 只告警一次且不注册 shell 工具",
  { concurrency: false },
  async () => {
    const dir = tempDir();
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let engine: ConversationEngine | undefined;
    try {
      let calls = 0;
      const toolSnapshots: string[] = [];
      engine = new ConversationEngine({
        config: sessionExecConfig(dir),
        model: toolCapturingModel((names) => {
          toolSnapshots.push(names);
        }),
        sources: [],
        skillLibrary: null,
        resolveShellProfileFn: () => {
          calls += 1;
          return { supported: false, reason: "pwsh-not-found" };
        },
      });
      const first = await engine.createSession();
      const second = await engine.createSession();
      const events = [];
      for (const session of [first, second]) {
        for await (const event of session.send("hi")) {
          events.push(event);
        }
      }

      assert.equal(calls, 1);
      assert.ok(events.length > 0);
      assert.equal(writes.filter((line) => line.includes("未检测到 PowerShell 7")).length, 1);
      assert.equal(toolSnapshots.length, 2);
      for (const tools of toolSnapshots) {
        assert.ok(!tools.includes("roll__bash"));
        assert.ok(!tools.includes("roll__powershell"));
        assert.ok(!tools.includes("roll__exec_command"));
        assert.ok(!tools.includes("roll__exec_poll"));
        assert.ok(!tools.includes("roll__exec_list"));
      }
      first.abort();
      second.abort();
    } finally {
      await engine?.dispose();
      process.stderr.write = originalWrite;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function installEngineConfig(dataDir: string) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir },
  });
}

const INSTALL_TEST_CATALOG = [
  {
    shortName: "probe",
    packageName: "@roll-agent/probe-agent",
    skillName: "probe-agent",
    description: "测试探针 Agent",
    requiredEnv: [],
  },
];

function makeProbeAgent(installPath: string): RegisteredAgent {
  return {
    skill: { name: "probe-agent", description: "测试探针", metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    installPath,
    registeredAt: "2026-07-01T00:00:00.000Z",
    status: "idle",
    source: {
      type: "installed-package",
      packageName: "@roll-agent/probe-agent",
      packageSpec: "@roll-agent/probe-agent",
      installDir: installPath,
      installedVersion: "1.0.0",
    },
  };
}

function installToolStream(): LanguageModelV4StreamPart[][] {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "roll__agent_install",
        input: JSON.stringify({ agent: "probe" }),
      },
      { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "完成" },
      { type: "text-end", id: "t" },
      { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
    ],
  ];
}

function installSequencedModel(): MockLanguageModelV4 {
  const steps = installToolStream();
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[Math.min(index, steps.length - 1)] ?? [];
      index += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function fakeProbeClientManager(connectCalls: string[]): McpClientManager {
  return {
    connect: async (agentName: string) => {
      connectCalls.push(agentName);
      return {
        listTools: async () => ({
          tools: [
            {
              name: "probe_tool",
              description: "探针工具",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      };
    },
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
}

test("chat 内安装不做持久 autoStart，改由会话租约启动并完成热刷新接线", async () => {
  const dataDir = tempDir();
  try {
    const connectCalls: string[] = [];
    const ensureReadyCalls: string[] = [];
    const installInputs: unknown[] = [];
    const engine = new ConversationEngine({
      config: installEngineConfig(dataDir),
      model: installSequencedModel(),
      skillLibrary: null,
      clientManager: fakeProbeClientManager(connectCalls),
      ensureAgentReady: async (agent) => {
        ensureReadyCalls.push(agent.skill.name);
      },
      resolveCatalogFn: async () => INSTALL_TEST_CATALOG,
      installAgentFn: async (input) => {
        installInputs.push(input);
        return {
          ok: true,
          agent: makeProbeAgent(dataDir),
          envReport: undefined,
          started: true,
        };
      },
    });

    const session = await engine.createSession();
    const outputs: string[] = [];
    for await (const event of session.send("装 probe")) {
      if (event.type === "confirmation-required") {
        session.approve(event.approvalId);
      }
      if (event.type === "tool-result") {
        assert.equal(event.isError, false);
        outputs.push(JSON.stringify(event.output));
      }
    }

    assert.equal(installInputs.length, 1);
    const input = installInputs[0] as {
      autoStart?: boolean;
      skipBrowserSetup?: boolean;
      packageSpec?: string;
      expectedSkillName?: string;
      replaceExisting?: boolean;
    };
    assert.equal(input.autoStart, false);
    assert.equal(input.skipBrowserSetup, true);
    assert.equal(input.packageSpec, "@roll-agent/probe-agent");
    assert.equal(input.expectedSkillName, "probe-agent");
    assert.equal(input.replaceExisting, undefined);
    assert.deepEqual(ensureReadyCalls, ["probe-agent"]);
    assert.deepEqual(connectCalls, ["probe-agent"]);
    assert.match(outputs[0] ?? "", /下一轮对话开始可用/);
    await engine.dispose();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("chat 内安装失败时不连接不刷新，错误如实透出", async () => {
  const dataDir = tempDir();
  try {
    const connectCalls: string[] = [];
    const engine = new ConversationEngine({
      config: installEngineConfig(dataDir),
      model: installSequencedModel(),
      skillLibrary: null,
      clientManager: fakeProbeClientManager(connectCalls),
      ensureAgentReady: async () => {},
      resolveCatalogFn: async () => INSTALL_TEST_CATALOG,
      installAgentFn: async () => ({
        ok: false,
        step: "start",
        message: 'Agent "probe-agent" 已安装，但自动启动失败：boom',
      }),
    });

    const session = await engine.createSession();
    let failureOutput = "";
    for await (const event of session.send("装 probe")) {
      if (event.type === "confirmation-required") {
        session.approve(event.approvalId);
      }
      if (event.type === "tool-result") {
        assert.equal(event.isError, true);
        failureOutput = JSON.stringify(event.output);
      }
    }

    assert.deepEqual(connectCalls, []);
    assert.match(failureOutput, /自动启动失败/);
    await engine.dispose();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("chat 内重装已接入的同名 agent 时不重复连接并提示重启", async () => {
  const dataDir = tempDir();
  try {
    const { AgentStore } = await import("@roll-agent/core/registry/store");
    new AgentStore(dataDir).add(makeProbeAgent(dataDir));

    const connectCalls: string[] = [];
    const reportLines: string[] = [];
    const engine = new ConversationEngine({
      config: installEngineConfig(dataDir),
      model: installSequencedModel(),
      skillLibrary: null,
      clientManager: fakeProbeClientManager(connectCalls),
      ensureAgentReady: async () => {},
      resolveCatalogFn: async () => INSTALL_TEST_CATALOG,
      installAgentFn: async (_input, deps) => {
        deps.report?.({ type: "info", message: "重装 probe" });
        return {
          ok: true,
          agent: makeProbeAgent(dataDir),
          envReport: undefined,
          started: true,
        };
      },
    });

    const session = await engine.createSession();
    let output = "";
    for await (const event of session.send("再装一次 probe")) {
      if (event.type === "confirmation-required") {
        session.approve(event.approvalId);
      }
      if (event.type === "tool-result") {
        output = JSON.stringify(event.output);
      }
    }

    assert.deepEqual(connectCalls, ["probe-agent"]);
    assert.match(output, /重新运行 roll chat/);
    assert.match(output, /已接入旧版本连接/);
    reportLines.push(output);
    await engine.dispose();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ConversationEngine 默认注册文件工具并标记 file-read/file-edit capability role", async () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config: installEngineConfig("/tmp/roll-engine-file-tools-default"),
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
      skillLibrary: null,
      shellProfile: null,
    });

    const session = await engine.createSession();
    const tools = session.getCapabilityManifest().tools;
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__read_file"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__list_dir"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__grep"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__glob"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__edit_file"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__write_file"));
    assert.ok(tools.some((tool) => tool.role === "file-verify" && tool.id === "roll__verify_file"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine fileToolsEnabled: false 时不注册文件工具", async () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config: installEngineConfig("/tmp/roll-engine-file-tools-disabled"),
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
      skillLibrary: null,
      shellProfile: null,
      fileToolsEnabled: false,
    });

    const session = await engine.createSession();
    const tools = session.getCapabilityManifest().tools;
    assert.ok(!tools.some((tool) => tool.role === "file-read"));
    assert.ok(!tools.some((tool) => tool.role === "file-edit"));
    assert.ok(!tools.some((tool) => tool.id === "roll__read_file"));
    assert.ok(!tools.some((tool) => tool.id === "roll__list_dir"));
    assert.ok(!tools.some((tool) => tool.id === "roll__edit_file"));
    assert.ok(!tools.some((tool) => tool.id === "roll__write_file"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine resumeSession 重建 session 后文件工具行为与 createSession 一致", async () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const engine = new ConversationEngine({
      config: installEngineConfig("/tmp/roll-engine-file-tools-resume"),
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
      skillLibrary: null,
      shellProfile: null,
    });

    const created = await engine.createSession();
    await created.close();
    const resumed = await engine.resumeSession(created.id);
    assert.notEqual(resumed, created);
    const tools = resumed.getCapabilityManifest().tools;
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__read_file"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__list_dir"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__edit_file"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__write_file"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function engineConfigWithInstructions(instructions: string) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
    chat: { instructions },
  });
}

function capturingModel(captured: Array<{ readonly role: string; readonly content: unknown }>) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(...options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] } as const,
            { type: "text-start", id: "t" } as const,
            { type: "text-delta", id: "t", delta: "ok" } as const,
            { type: "text-end", id: "t" } as const,
            {
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: "stop" },
            } as const,
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

test("ConversationEngine 把显式 workspaceInstructions source 注入 session system prompt 并暴露 instructionsPath", async () => {
  const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
  const engine = new ConversationEngine({
    config: engineConfigWithInstructions("auto"),
    model: capturingModel(captured),
    sources: [],
    skillLibrary: null,
    workspaceInstructions: {
      current: () => ({
        path: "/repo/AGENTS.md",
        content: "engine rules",
        truncated: false,
        totalChars: 12,
      }),
    },
  });
  const summary = await engine.getContextSummary();
  assert.equal(summary.instructionsPath, "/repo/AGENTS.md");
  const session = await engine.createSession();
  await drain(session.send("hi"));
  const system = captured.find((message) => message.role === "system");
  assert.ok(system);
  assert.ok(String(system.content).includes("# 工作区工程约定"));
  assert.ok(String(system.content).includes("engine rules"));
  await engine.dispose();
});

test("ConversationEngine workspaceInstructions 为 null 或 config off 时不注入", async () => {
  for (const variant of ["null", "off"] as const) {
    const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
    const engine = new ConversationEngine({
      config: engineConfigWithInstructions(variant === "off" ? "off" : "auto"),
      model: capturingModel(captured),
      sources: [],
      skillLibrary: null,
      ...(variant === "null" ? { workspaceInstructions: null } : {}),
    });
    const summary = await engine.getContextSummary();
    assert.equal(summary.instructionsPath, undefined, variant);
    const session = await engine.createSession();
    await drain(session.send("hi"));
    const system = captured.find((message) => message.role === "system");
    assert.ok(system, variant);
    assert.ok(!String(system.content).includes("# 工作区工程约定"), variant);
    await engine.dispose();
  }
});

test("ConversationEngine 按 config 构造 source 时把告警转给 onWorkspaceInstructionsIssue", async () => {
  const dir = tempDir();
  try {
    const missing = join(dir, "nope.md");
    const issues: string[] = [];
    const engine = new ConversationEngine({
      config: engineConfigWithInstructions(missing),
      model: new MockLanguageModelV4({}),
      sources: [],
      skillLibrary: null,
      onWorkspaceInstructionsIssue: (message) => issues.push(message),
    });
    const summary = await engine.getContextSummary();
    assert.equal(summary.instructionsPath, undefined);
    assert.equal(issues.length, 1);
    assert.ok(issues[0]?.includes(missing));
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDynamicCapabilityContext 的 origin 会透传到 turn context", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const engine = new ConversationEngine({
    config,
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: engineTextStep("ok"),
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }),
    sources: [],
    skillLibrary: null,
    workspaceInstructions: null,
    hostMode: CAPABILITY_HOST_MODES.background,
    resolveDynamicCapabilityContext: () => ({
      origin: {
        kind: "scheduled",
        scheduleId: "sched-1",
        invocationId: "inv-1",
        scheduledFor: "2026-08-25T09:00:00.000Z",
        unattended: true,
      },
    }),
  });
  try {
    const session = await engine.createSession();
    await drain(session.send("hi"));
    const context = session.getCapabilityTurnContext();
    assert.equal(context?.version, 2);
    assert.equal(context?.dynamic.origin?.invocationId, "inv-1");
    assert.equal(context?.lifecycle.hostMode, CAPABILITY_HOST_MODES.background);
  } finally {
    await engine.dispose();
  }
});

test("buildSessionBashSettings 只在提供 onCommandSpawn 时写入该字段", () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    runtime: { model: "runtime-model" },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const onCommandSpawn = () => {};
  const withHook = buildSessionBashSettings({
    config,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
    onCommandSpawn,
  });
  assert.equal(withHook.onCommandSpawn, onCommandSpawn);
  assert.equal(withHook.profile, powershellProfile);
  assert.deepEqual(withHook.env, { PATH: "/usr/bin" });
  assert.equal(withHook.turnTimeoutMs, config.runtime.turnTimeoutMs);
  const without = buildSessionBashSettings({
    config,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
  });
  assert.equal("onCommandSpawn" in without, false);
});

test("buildSessionExecSettings 只在提供 onCommandSpawn 时写入该字段", () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    runtime: { model: "runtime-model" },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const onCommandSpawn = () => {};
  const withHook = buildSessionExecSettings({
    config,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
    onCommandSpawn,
  });
  assert.equal(withHook.onCommandSpawn, onCommandSpawn);
  assert.equal(withHook.maxSessions, config.runtime.shell.session.maxSessions);
  assert.equal(withHook.bufferCapacity, config.runtime.shell.maxCaptureBytes);
  const without = buildSessionExecSettings({
    config,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
  });
  assert.equal("onCommandSpawn" in without, false);
});
