import { mapRuntimeSettings } from "./engine-factory.ts";

import { CoreAgentHost, type CoreAgentHostOptions } from "./agent-host.ts";

import { createProviderModel, providerAcceptsToolSchemaIssues } from "../llm/providers.ts";

import {
  ConversationEngine,
  ThreadStore,
  type ConversationEngineOptions,
  type EngineModelSwitch,
  type AgentSession,
  type AgentBootstrapIssue,
} from "@roll-agent/runtime";

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

import { test } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { simulateReadableStream } from "ai";

import { MockLanguageModelV4 } from "ai/test";

import { rollConfigSchema } from "@roll-agent/core/config/schema";

import type {
  McpClientManager,
  McpConnectionAcquisition,
} from "@roll-agent/core/mcp/client-manager";

import type { AgentUsageLease } from "@roll-agent/core/registry/agent-usage-lease";

import type { RegisteredAgent } from "@roll-agent/core/types/agent";

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
    const engine = createEngine({
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
  const engine = createEngine({
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
  // A rolled-back acquisition leaves no owned connection to release globally.
  assert.deepEqual(order, ["connect", "connected", "disconnect"]);
  assert.deepEqual(issues, []);
});

test("ConversationEngine.dispose 等待 live session close 后才断开 MCP", async () => {
  const order: string[] = [];
  const closeStarted = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const clientManager = {
    connect: async () => ({ listTools: async () => ({ tools: [] }) }),
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
  const engine = createEngine({
    config,
    model: new MockLanguageModelV4({}),
    agents: [makeManagedHttpAgent("close-order")],
    ensureAgentReady: async () => {},
    skillLibrary: null,
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
  const engine = createEngine({
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
  const engine = createEngine({
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
  const engine = createEngine({
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
    connect: async () => ({ listTools: async () => ({ tools: [] }) }),
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
  const engine = createEngine({
    config,
    model: new MockLanguageModelV4({}),
    agents: [makeManagedHttpAgent("close-failure")],
    ensureAgentReady: async () => {},
    skillLibrary: null,
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
  const engine = createEngine({
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
  const engine = createEngine({
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
  const engine = createEngine({
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
  const engine = createEngine({
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
  const engine = createEngine({
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
  const engine = createEngine({
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
  const engine = createEngine({
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

  const refresh = await registerAndRefresh(engine, agent);
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
  const engine = createEngine({
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
  const engine = createEngine({
    config: installEngineConfig("/tmp/roll-engine-shared-refresh"),
    model: new MockLanguageModelV4({}),
    agents: [agent],
    skillLibrary: null,
    shellProfile: null,
    clientManager,
    acquireAgentUsage: async () => lease,
  });

  await engine.createSession();
  await assert.rejects(registerAndRefresh(engine, agent), /refresh list failed/u);

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
  const engine = createEngine({
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
    engine = createEngine({
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
  const engine = createEngine({
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

  const firstRefresh = registerAndRefresh(engine, firstAgent);
  await starts[0]?.promise;
  const secondRefresh = registerAndRefresh(engine, secondAgent);
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
  const engine = createEngine({
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

  assert.deepEqual(ensured, [
    {
      agentName: "browser-use-agent",
      env: { TEST_ENV: "1", BROWSER_OPERATE_ENGINE: "sampling" },
    },
  ]);
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
  const engine = createEngine({
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
  assert.deepEqual(updatedProviderOptions, [providerOptions, nextProviderOptions]);

  await registerAndRefresh(engine, agent);
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
  const engine = createEngine({
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
    switchModel(engine, {
      provider: "mock",
      modelName: "gemini-3.8-flash",
      model: next,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: "medium" } } },
    });

    assert.deepEqual(samplingModels, [initial, next]);
    assert.deepEqual(samplingOptions, [
      undefined,
      { google: { thinkingConfig: { thinkingLevel: "medium" } } },
    ]);
    assert.equal(store.getThread(session.id)?.model, "gemini-3.8-flash");
    assert.equal(session.getContextWindow(), 1_000_000);

    const created = await engine.createSession();
    assert.equal(store.getThread(created.id)?.model, "gemini-3.8-flash");

    await registerAndRefresh(engine, agent);
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
  const engine = createEngine({
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
      () => switchModel(engine, { provider: "mock", modelName: "next", model: next }),
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

test("ConversationEngine excludes tools whose leftover refs the provider rejects and re-evaluates on model switch and agent refresh", async () => {
  const makeAgent = (name: string): RegisteredAgent => ({
    skill: { name, description: name, metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    installPath: `/tmp/${name}`,
    registeredAt: "2026-06-17T00:00:00.000Z",
    status: "idle",
  });
  const recursiveRootTool = {
    name: "tree",
    inputSchema: {
      type: "object",
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
      properties: { root: { $ref: "#/$defs/node" } },
    },
  };
  const brokenTool = {
    name: "broken",
    inputSchema: { type: "object", properties: { x: { $ref: "#/properties/nope" } } },
  };
  const plainTool = { name: "ping", inputSchema: { type: "object", properties: {} } };
  const lateTool = {
    name: "late",
    inputSchema: { type: "object", properties: { y: { $ref: "#/properties/missing" } } },
  };
  const toolsByAgent: Record<string, readonly object[]> = {
    "schema-agent": [recursiveRootTool, brokenTool, plainTool],
    "late-agent": [lateTool],
  };
  const makeEngine = (provider: string) => {
    const issues: string[] = [];
    const engine = createEngine({
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
      agents: [makeAgent("schema-agent")],
      skillLibrary: null,
      clientManager: {
        connect: async (agentName: string) => ({
          listTools: async () => ({ tools: toolsByAgent[agentName] ?? [] }),
        }),
        setSamplingProviderOptions: () => {},
        setSamplingModel: () => {},
        disconnectAll: async () => {},
      } as unknown as McpClientManager,
      onAgentBootstrapIssue: (issue) => issues.push(issue.message),
    });
    return { engine, issues };
  };
  const toolIds = (session: AgentSession): readonly string[] =>
    session.getCapabilityManifest().tools.map((tool) => tool.id);
  const has = (ids: readonly string[], suffix: string): boolean =>
    ids.some((id) => id.endsWith(suffix));

  const google = makeEngine("google");
  try {
    const session = await google.engine.createSession();
    let ids = toolIds(session);
    assert.ok(has(ids, "ping"));
    assert.ok(has(ids, "tree"), "root-level recursive $defs stay usable on google");
    assert.ok(!has(ids, "broken"), "unresolvable #/properties ref is excluded on google");
    assert.ok(
      google.issues.some(
        (message) => message.includes('"broken"') && message.includes("已从本会话工具集移除"),
      ),
    );

    switchModel(google.engine, {
      provider: "openai",
      modelName: "gpt",
      model: new MockLanguageModelV4({ modelId: "gpt" }),
    });
    ids = toolIds(session);
    assert.ok(has(ids, "broken"), "switching to a pass-through provider restores the tool");

    switchModel(google.engine, {
      provider: "google",
      modelName: "gemini",
      model: new MockLanguageModelV4({ modelId: "gemini" }),
    });
    ids = toolIds(session);
    assert.ok(!has(ids, "broken"), "switching back to google excludes it again");

    const refresh = await registerAndRefresh(google.engine, makeAgent("late-agent"));
    session.applyAgentRefresh(refresh);
    ids = toolIds(session);
    assert.ok(!has(ids, "late"), "tools installed mid-session go through the same policy");
    assert.ok(google.issues.some((message) => message.includes('"late"')));
  } finally {
    await google.engine.dispose();
  }

  const openai = makeEngine("openai");
  try {
    const session = await openai.engine.createSession();
    assert.ok(has(toolIds(session), "broken"));
    switchModel(openai.engine, {
      provider: "google",
      modelName: "gemini",
      model: new MockLanguageModelV4({ modelId: "gemini" }),
    });
    assert.ok(!has(toolIds(session), "broken"), "stale toolset is re-validated on switch");
    assert.ok(
      openai.issues.some(
        (message) => message.includes('"broken"') && message.includes('provider "google"'),
      ),
      "switch warnings name the target provider",
    );
  } finally {
    await openai.engine.dispose();
  }
});

const STOP_REASON = { unified: "stop", raw: "stop" } as const;

const TOOL_CALLS_REASON = { unified: "tool-calls", raw: "tool-calls" } as const;

function mockUsage(inputTokens = 1, outputTokens = 1) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
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

test("ConversationEngine passes advertised tool timeout through discovery and execution", async () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-timeout-test" },
  });
  const agent: RegisteredAgent = {
    skill: { name: "deadline-agent", description: "test", metadata: {} },
    transport: { type: "stdio", command: "node" },
    runtime: { ownership: "on-demand" },
    installPath: "/tmp/deadline-agent",
    registeredAt: "2026-09-20T00:00:00Z",
    status: "idle",
  };
  let timeout: unknown;
  const clientManager = {
    connect: async () => ({
      listTools: async () => ({
        tools: [
          {
            name: "run",
            inputSchema: { type: "object", properties: {} },
            _meta: { "roll/executionTimeoutMs": 120000 },
          },
        ],
      }),
      callTool: async (_request: unknown, _schema: unknown, options: { timeout?: number }) => {
        timeout = options.timeout;
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const model = sequencedEngineModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "deadline-call",
        toolName: "deadline-agent__run",
        input: "{}",
      },
      { type: "finish", usage: mockUsage(), finishReason: TOOL_CALLS_REASON },
    ],
    engineTextStep("done"),
  ]);
  const engine = createEngine({
    config,
    model,
    agents: [agent],
    skillLibrary: null,
    workspaceInstructions: null,
    clientManager,
    ensureAgentReady: async () => {},
  });
  try {
    const session = await engine.createSession();
    await drain(session.send("run"));
    assert.equal(timeout, 120000);
  } finally {
    await engine.dispose();
  }
});

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
  const engine = createEngine({
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
  const trimmedEngine = createEngine({
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
    const engine = createEngine({
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
    const engine = createEngine({
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
    const engine = createEngine({
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

test("ConversationEngine 从 MCP 声明接入观察投影并拒绝无效声明", async () => {
  const agent = makeManagedHttpAgent("observing-agent");
  const issues: AgentBootstrapIssue[] = [];
  const prompts: LanguageModelV4CallOptions[] = [];
  let modelIndex = 0;
  let observationIndex = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options);
      const index = modelIndex++;
      const chunks =
        index < 2
          ? engineToolCallStep(`observation-${index}`, "observing-agent__snapshot", {})
          : engineTextStep("done");
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const clientManager = {
    connect: async () => ({
      listTools: async () => ({
        tools: [
          {
            name: "snapshot",
            inputSchema: { type: "object", properties: {} },
            _meta: { "roll/observationRetention": { kind: "browser-ax-snapshot" } },
          },
          {
            name: "invalid_observation",
            inputSchema: { type: "object", properties: {} },
            _meta: { "roll/observationRetention": { kind: "unknown" } },
          },
        ],
      }),
      callTool: async () => {
        const index = observationIndex++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                page: { url: "https://example.test" },
                snapshot: {
                  snapshotId: `snapshot-${index}`,
                  browserInstance: "browser-a",
                  pageId: "page-a",
                  documentId: "document-a",
                  nodes: [
                    {
                      role: "textbox",
                      name: `field-${index}`,
                      ref: "@e1",
                      depth: 0,
                      ignored: false,
                    },
                  ],
                  refs: [
                    {
                      ref: "@e1",
                      role: "textbox",
                      name: `field-${index}`,
                      nth: 0,
                      disabled: false,
                    },
                  ],
                  nodeCount: 1,
                  truncated: false,
                  maxNodes: 100,
                  interactiveOnly: true,
                },
              }),
            },
          ],
        };
      },
    }),
    disconnectAll: async () => {},
  } as unknown as McpClientManager;
  const engine = createEngine({
    config: installEngineConfig("/tmp/roll-observation-metadata"),
    model,
    agents: [agent],
    clientManager,
    ensureAgentReady: async () => {},
    skillLibrary: null,
    workspaceInstructions: null,
    shellProfile: null,
    onAgentBootstrapIssue: (issue) => issues.push(issue),
  });
  try {
    const session = await engine.createSession();
    await drain(session.send("inspect"));
    assert.equal(observationIndex, 2);
    assert.match(JSON.stringify(prompts[2]?.prompt), /historicalObservation/u);
    assert.match(issues[0]?.message ?? "", /roll\/observationRetention 无效/u);
  } finally {
    await engine.dispose();
  }
});

type FixtureEngineOptions = Omit<
  ConversationEngineOptions,
  "settings" | "provider" | "modelName" | "model" | "agentHost"
> &
  Omit<CoreAgentHostOptions, "clientManager"> & {
    readonly model?: LanguageModelV4;
    readonly clientManager?: McpClientManager;
  };

const fixtureAgents = new WeakMap<ConversationEngine, RegisteredAgent[]>();

function createEngine(input: FixtureEngineOptions): ConversationEngine {
  const {
    config,
    agents,
    clientManager,
    ensureAgentReady,
    acquireAgentUsage,
    onSkillLibraryIssue,
    installAgentFn,
    resolveCatalogFn,
    model: explicitModel,
    sources,
    ...execution
  } = input;
  const provider = config.runtime.provider ?? config.llm.defaultProvider;
  const modelName = config.runtime.model ?? config.llm.defaultModel;
  const providerConfig = config.llm.providers[provider];
  const model =
    explicitModel ??
    createProviderModel(provider, modelName, providerConfig?.apiKey ?? "", providerConfig?.baseUrl);
  const mutableAgents = agents === undefined ? undefined : [...agents];
  let disconnected: Promise<void> | undefined;
  const host =
    sources === undefined
      ? new CoreAgentHost({
          config,
          ...(mutableAgents ? { agents: mutableAgents } : {}),
          ...(ensureAgentReady ? { ensureAgentReady } : {}),
          ...(acquireAgentUsage ? { acquireAgentUsage } : {}),
          ...(onSkillLibraryIssue ? { onSkillLibraryIssue } : {}),
          ...(installAgentFn ? { installAgentFn } : {}),
          ...(resolveCatalogFn ? { resolveCatalogFn } : {}),
          ...(input.onAgentBootstrapIssue
            ? { onAgentBootstrapIssue: input.onAgentBootstrapIssue }
            : {}),
          ...(input.skillLibrary === undefined ? {} : { skillLibrary: input.skillLibrary }),
          ...(clientManager
            ? {
                clientManager: {
                  connectScoped: async (name, transport, cwd, options) => {
                    const acquired =
                      typeof clientManager.connectWithOwnership === "function"
                        ? await clientManager.connectWithOwnership(name, transport, cwd, options)
                        : {
                            client: await clientManager.connect(name, transport, cwd, options),
                            commit: () => {},
                            rollback: async () => {},
                          };
                    return {
                      ...acquired,
                      release: (serverExited = false) => {
                        disconnected ??= clientManager.disconnectAll(
                          serverExited ? new Set([name]) : new Set(),
                        );
                        return disconnected;
                      },
                      setSampling: (nextModel, nextOptions) => {
                        clientManager.setSamplingModel?.(nextModel);
                        clientManager.setSamplingProviderOptions?.(nextOptions);
                      },
                    };
                  },
                },
              }
            : {}),
        })
      : undefined;
  const engine = new ConversationEngine({
    ...execution,
    settings: mapRuntimeSettings(config),
    provider,
    modelName,
    model,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(provider, issues),
    ...(host ? { agentHost: host } : { sources: sources ?? [] }),
  });
  if (mutableAgents) fixtureAgents.set(engine, mutableAgents);
  return engine;
}

function registerAndRefresh(engine: ConversationEngine, agent: RegisteredAgent) {
  const agents = fixtureAgents.get(engine);
  if (agents) {
    const index = agents.findIndex((item) => item.skill.name === agent.skill.name);
    if (index < 0) agents.push(agent);
    else agents[index] = agent;
  }
  return engine.prepareAgentRefresh(agent.skill.name);
}

function switchModel(engine: ConversationEngine, input: EngineModelSwitch) {
  return engine.switchModel({
    ...input,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(input.provider, issues),
  });
}
