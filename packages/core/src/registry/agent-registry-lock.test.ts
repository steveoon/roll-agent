import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireAgentRegistryLock, AgentRegistryBusyError } from "./agent-registry-lock.ts";
import { AgentStore } from "./store.ts";
import type { RegisteredAgent } from "../types/agent.ts";

describe("Agent registry lock", () => {
  it("lets one transaction make multiple Store mutations while rejecting another writer", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-agent-registry-lock-"));
    const lock = acquireAgentRegistryLock(dataDir);
    try {
      const transactionStore = new AgentStore(dataDir, { registryLock: lock });
      transactionStore.add(makeAgent("alpha"));
      transactionStore.add(makeAgent("beta"));

      assert.throws(
        () => acquireAgentRegistryLock(dataDir, { timeoutMs: 0 }),
        AgentRegistryBusyError,
      );
      assert.equal(transactionStore.findByName("alpha")?.status, "idle");
      assert.equal(transactionStore.list().length, 2);
    } finally {
      lock.release();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("allows the next writer after the transaction releases its lock", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-agent-registry-lock-"));
    const lock = acquireAgentRegistryLock(dataDir);
    try {
      new AgentStore(dataDir, { registryLock: lock }).add(makeAgent("alpha"));
      lock.release();

      const nextStore = new AgentStore(dataDir);
      nextStore.updateStatus("alpha", "online");
      assert.equal(nextStore.findByName("alpha")?.status, "online");
    } finally {
      lock.release();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function makeAgent(name: string): RegisteredAgent {
  return {
    skill: { name, description: "test", metadata: {} },
    transport: { type: "stdio", command: "node" },
    runtime: { ownership: "on-demand" },
    installPath: `/tmp/${name}`,
    registeredAt: "2026-07-23T00:00:00.000Z",
    status: "idle",
  };
}
