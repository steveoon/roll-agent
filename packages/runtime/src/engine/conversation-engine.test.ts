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
import type { ShellProfile } from "../bash/profile.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-engine-"));
}

const powershellProfile: ShellProfile = {
  id: "powershell",
  toolName: "powershell",
  supportsSessionExec: false,
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

test("PowerShell profile 注册 roll__powershell 且不注册 session exec", async () => {
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
    assert.ok(!tools.includes("roll__exec_command"));
    assert.ok(!tools.includes("roll__exec_poll"));
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
