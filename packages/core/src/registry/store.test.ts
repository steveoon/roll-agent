import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "./store.ts";
import type { RegisteredAgent } from "../types/agent.ts";

function createTmpDir(): string {
  const dir = join(tmpdir(), `roll-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAgent(name: string): RegisteredAgent {
  return {
    skill: {
      name,
      description: `${name} description`,
      metadata: {},
    },
    transport: { type: "stdio", command: "node", args: ["src/index.ts"] },
    installPath: `/tmp/${name}`,
    registeredAt: new Date().toISOString(),
    status: "idle",
  };
}

describe("AgentStore", () => {
  let tmpDir: string;
  let store: AgentStore;

  beforeEach(() => {
    tmpDir = createTmpDir();
    store = new AgentStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty list when no agents registered", () => {
    assert.deepEqual(store.list(), []);
  });

  it("should add and retrieve an agent", () => {
    const agent = makeAgent("test-agent");
    store.add(agent);

    const agents = store.list();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.skill.name, "test-agent");
  });

  it("should find agent by name", () => {
    store.add(makeAgent("agent-a"));
    store.add(makeAgent("agent-b"));

    const found = store.findByName("agent-b");
    assert.equal(found?.skill.name, "agent-b");
    assert.equal(store.findByName("nonexistent"), undefined);
  });

  it("should throw when adding duplicate name", () => {
    store.add(makeAgent("dup-agent"));
    assert.throws(
      () => store.add(makeAgent("dup-agent")),
      (err: Error) => err.message.includes("already registered"),
    );
  });

  it("should remove an agent", () => {
    store.add(makeAgent("to-remove"));
    assert.equal(store.remove("to-remove"), true);
    assert.equal(store.list().length, 0);
  });

  it("should return false when removing nonexistent agent", () => {
    assert.equal(store.remove("nonexistent"), false);
  });

  it("should update agent status", () => {
    store.add(makeAgent("status-agent"));
    store.updateStatus("status-agent", "online");

    const agent = store.findByName("status-agent");
    assert.equal(agent?.status, "online");
  });

  it("should persist across store instances", () => {
    store.add(makeAgent("persist-agent"));

    const store2 = new AgentStore(tmpDir);
    assert.equal(store2.list().length, 1);
    assert.equal(store2.findByName("persist-agent")?.skill.name, "persist-agent");
  });
});
