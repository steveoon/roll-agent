import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RegisteredAgent } from "../types/agent.ts";
import { type AgentUsageLease, acquireAgentUsageLease } from "../registry/agent-usage-lease.ts";
import type { McpClientManager } from "./client-manager.ts";
import { ManagedAgentConnectionScope } from "./managed-agent-connection.ts";

describe("ManagedAgentConnectionScope", () => {
  it("deduplicates concurrent connections and holds one lease for the Agent", async () => {
    const order: string[] = [];
    const acquireStarted = Promise.withResolvers<void>();
    const releaseAcquire = Promise.withResolvers<void>();
    const client = {} as Client;
    let acquireCalls = 0;
    let connectCalls = 0;
    let releaseCalls = 0;
    const lease = makeLease(async () => {
      releaseCalls += 1;
      order.push("release");
    });
    const acquireUsage: typeof acquireAgentUsageLease = async () => {
      acquireCalls += 1;
      acquireStarted.resolve();
      await releaseAcquire.promise;
      return lease;
    };
    const clientManager = {
      connect: async () => {
        connectCalls += 1;
        return client;
      },
      disconnectAll: async () => {
        order.push("disconnect");
      },
    } as unknown as McpClientManager;
    const scope = new ManagedAgentConnectionScope(
      "/tmp/roll-managed-connection-test",
      "run",
      clientManager,
      acquireUsage,
    );

    const first = scope.connect(MANAGED_AGENT);
    await acquireStarted.promise;
    const second = scope.connect(MANAGED_AGENT);
    releaseAcquire.resolve();

    assert.equal(await first, client);
    assert.equal(await second, client);
    assert.equal(acquireCalls, 1);
    assert.equal(connectCalls, 1);

    await scope.disconnectAll();
    assert.equal(releaseCalls, 1);
    assert.deepEqual(order, ["disconnect", "release"]);
  });

  it("releases a newly acquired lease when MCP connect fails", async () => {
    let releaseCalls = 0;
    const lease = makeLease(async () => {
      releaseCalls += 1;
    });
    const clientManager = {
      connect: async () => {
        throw new Error("connect failed");
      },
      disconnectAll: async () => {},
    } as unknown as McpClientManager;
    const scope = new ManagedAgentConnectionScope(
      "/tmp/roll-managed-connection-test",
      "ask",
      clientManager,
      async () => lease,
    );

    await assert.rejects(scope.connect(MANAGED_AGENT), /connect failed/u);
    assert.equal(releaseCalls, 1);
    await scope.disconnectAll();
    assert.equal(releaseCalls, 1);
  });

  it("still releases leases when MCP disconnect fails", async () => {
    const order: string[] = [];
    const lease = makeLease(async () => {
      order.push("release");
    });
    const clientManager = {
      connect: async () => ({}) as Client,
      disconnectAll: async () => {
        order.push("disconnect");
        throw new Error("disconnect failed");
      },
    } as unknown as McpClientManager;
    const scope = new ManagedAgentConnectionScope(
      "/tmp/roll-managed-connection-test",
      "agent-tools",
      clientManager,
      async () => lease,
    );

    await scope.connect(MANAGED_AGENT);
    await assert.rejects(scope.disconnectAll(), /disconnect failed/u);
    assert.deepEqual(order, ["disconnect", "release"]);
  });
});

const MANAGED_AGENT: RegisteredAgent = {
  skill: { name: "managed-agent", description: "test", metadata: {} },
  transport: { type: "streamable-http", endpoint: "http://127.0.0.1:3199/mcp" },
  runtime: {
    ownership: "core-managed",
    start: { command: "node", args: ["dist/index.js"] },
    endpoint: { path: "/mcp", port: 3_199 },
  },
  installPath: "/tmp/managed-agent",
  registeredAt: "2026-07-23T00:00:00.000Z",
  status: "online",
};

function makeLease(release: () => Promise<void>): AgentUsageLease {
  return {
    agentName: MANAGED_AGENT.skill.name,
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
