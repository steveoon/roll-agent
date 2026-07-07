import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import type { McpClientManager } from "@roll-agent/core/mcp/client-manager";
import type { RegisteredAgent } from "@roll-agent/core/types/agent";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { ThreadStore } from "../store/thread-store.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import { ConversationEngine, type AgentBootstrapIssue } from "./conversation-engine.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-engine-"));
}

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
  };
  const ensured: Array<{
    readonly agentName: string;
    readonly env: Readonly<Record<string, string>> | undefined;
  }> = [];
  const connected: string[] = [];
  const clientManager = {
    connect: async (agentName: string) => {
      connected.push(agentName);
      return { listTools: async () => ({ tools: [] }) };
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

  await engine.createSession();

  assert.deepEqual(ensured, [{ agentName: "browser-use-agent", env: { TEST_ENV: "1" } }]);
  assert.deepEqual(connected, ["browser-use-agent"]);
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

function bashThenDoneModel(command: string): MockLanguageModelV4 {
  const steps: LanguageModelV4StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "roll__bash",
        input: JSON.stringify({ command }),
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

function bashEngineConfig(dataDir: string, autoApproveSafe: boolean) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    runtime: { bash: { enabled: true, autoApproveSafe } },
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
        model: bashThenDoneModel("pwd"),
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
        model: bashThenDoneModel("pwd"),
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

function sessionExecConfig(dataDir: string) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    runtime: { bash: { enabled: true, session: { enabled: true } } },
    agents: { dataDir },
  });
}

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
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
