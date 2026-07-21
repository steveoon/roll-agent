import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import type { McpClientManager } from "@roll-agent/core/mcp/client-manager";
import type { RegisteredAgent } from "@roll-agent/core/types/agent";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { ThreadStore } from "../store/thread-store.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import type { SessionEvent } from "../types/events.ts";
import { ConversationEngine, type AgentBootstrapIssue } from "./conversation-engine.ts";
import type { ShellProfile } from "../bash/profile.ts";
import { killProcessGroup } from "../bash/kill.ts";
import { executeTranscriptTool } from "../tool-bridge/transcript-tool.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  TOOL_RESOURCE_HINT_KINDS,
} from "../tool-bridge/tool-execution-coordinator.ts";
import { createEmptyCompactionToolState } from "./compaction-checkpoint.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-engine-"));
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

function mockUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
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
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: mockUsage(), finishReason: TOOL_CALLS_REASON },
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
    assert.match(JSON.stringify(record?.raw), /kept-in-raw-ledger/u);

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
    assert.doesNotMatch(capturedPrompt, /old-goal/u);

    await engine.dispose();
    store.close();
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
    assert.equal(third.goal?.verbatimRequest, "现在允许修改公开 API");
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
    assert.doesNotMatch(finalPrompt, /绝对不要修改公开 API/u);
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

test("chat 内安装走统一启动状态机（autoStart）并完成热刷新接线", async () => {
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
    assert.equal(input.autoStart, true);
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
