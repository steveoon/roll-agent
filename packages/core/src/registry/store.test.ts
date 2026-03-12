import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentStore } from "./store.ts";
import type { RegisteredAgent } from "../types/agent.ts";

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-test-${randomUUID()}`);
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
    transport: { type: "stdio", command: "node" },
    installPath: `/tmp/${name}`,
    registeredAt: new Date().toISOString(),
    status: "idle",
  };
}

describe("AgentStore", () => {
  let tmpDir: string;
  let store: AgentStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new AgentStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty list when no agents registered", () => {
    const agents = store.list();
    assert.deepEqual(agents, []);
  });

  it("should add and list an agent", () => {
    const agent = makeAgent("test-agent");
    store.add(agent);

    const agents = store.list();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.skill.name, "test-agent");
  });

  it("should find agent by name", () => {
    store.add(makeAgent("alpha"));
    store.add(makeAgent("beta"));

    const found = store.findByName("beta");
    assert.ok(found);
    assert.equal(found.skill.name, "beta");
  });

  it("should return undefined for unknown agent name", () => {
    store.add(makeAgent("alpha"));
    const found = store.findByName("nonexistent");
    assert.equal(found, undefined);
  });

  it("should throw when adding duplicate agent name", () => {
    store.add(makeAgent("dup"));
    assert.throws(
      () => store.add(makeAgent("dup")),
      (err: Error) => err.message.includes("already registered"),
    );
  });

  it("should remove an agent by name", () => {
    store.add(makeAgent("to-remove"));
    store.add(makeAgent("to-keep"));

    const removed = store.remove("to-remove");
    assert.equal(removed, true);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.skill.name, "to-keep");
  });

  it("should return false when removing nonexistent agent", () => {
    const removed = store.remove("ghost");
    assert.equal(removed, false);
  });

  it("should update agent status", () => {
    store.add(makeAgent("status-test"));
    assert.equal(store.findByName("status-test")?.status, "idle");

    store.updateStatus("status-test", "online");
    assert.equal(store.findByName("status-test")?.status, "online");
  });

  it("should replace agent atomically", () => {
    store.add(makeAgent("alpha"));
    store.add(makeAgent("beta"));

    const next = makeAgent("alpha");
    const replaced = store.replace("alpha", {
      ...next,
      skill: { ...next.skill, description: "new description" },
      transport: { type: "streamable-http", endpoint: "http://localhost:3000/mcp" },
    });

    assert.equal(replaced, true);
    assert.equal(store.findByName("alpha")?.skill.description, "new description");
    assert.equal(store.list().length, 2);
  });

  it("should throw when replace would conflict with existing name", () => {
    store.add(makeAgent("alpha"));
    store.add(makeAgent("beta"));

    const renamed = makeAgent("beta");
    assert.throws(
      () => store.replace("alpha", renamed),
      (err: Error) => err.message.includes("already registered"),
    );
    assert.equal(store.findByName("alpha")?.skill.name, "alpha");
    assert.equal(store.findByName("beta")?.skill.name, "beta");
  });

  it("should persist across new store instances", () => {
    store.add(makeAgent("persistent"));
    const store2 = new AgentStore(tmpDir);
    assert.equal(store2.list().length, 1);
    assert.equal(store2.findByName("persistent")?.skill.name, "persistent");
  });

  it("should create data directory if it does not exist", () => {
    const deepDir = resolve(tmpDir, "deep", "nested", "dir");
    const deepStore = new AgentStore(deepDir);
    deepStore.add(makeAgent("deep-agent"));
    assert.equal(deepStore.list().length, 1);
  });

  it("should return empty list when store file contains invalid JSON", () => {
    writeFileSync(resolve(tmpDir, "agents.json"), "{invalid json", "utf-8");
    assert.deepEqual(store.list(), []);
  });
});
