import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import type { McpClientManager } from "@roll-agent/core/mcp/client-manager";
import type { RegisteredAgent } from "@roll-agent/core/types/agent";
import { ThreadStore } from "../store/thread-store.ts";
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
