import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentStore } from "./store.ts";
import { createDefaultRuntimeForTransport } from "../types/agent.ts";
import type { RegisteredAgent } from "../types/agent.ts";

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAgent(name: string): RegisteredAgent {
  const transport = { type: "stdio", command: "node" } as const;
  return {
    skill: {
      name,
      description: `${name} description`,
      metadata: {},
    },
    transport,
    runtime: createDefaultRuntimeForTransport(transport),
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

  it("should persist structured env declarations", () => {
    const agent = makeAgent("env-agent");
    store.add({
      ...agent,
      skill: {
        ...agent.skill,
        env: {
          required: [{ name: "API_TOKEN", purpose: "Access upstream API" }],
          optional: [{ name: "MODEL_ID", default: "provider/default-model" }],
        },
      },
    });

    const reloaded = new AgentStore(tmpDir).findByName("env-agent");
    assert.deepEqual(reloaded?.skill.env, {
      required: [{ name: "API_TOKEN", purpose: "Access upstream API" }],
      optional: [{ name: "MODEL_ID", default: "provider/default-model" }],
    });
  });

  it("should persist installed-package source version metadata", () => {
    const agent = makeAgent("installed-agent");
    store.add({
      ...agent,
      source: {
        type: "installed-package",
        packageName: "@roll-agent/installed-agent",
        packageSpec: "@roll-agent/installed-agent@latest",
        installDir: "/tmp/installed-agent",
        installedVersion: "1.2.3",
      },
    });

    const reloaded = new AgentStore(tmpDir).findByName("installed-agent");
    assert.deepEqual(reloaded?.source, {
      type: "installed-package",
      packageName: "@roll-agent/installed-agent",
      packageSpec: "@roll-agent/installed-agent@latest",
      installDir: "/tmp/installed-agent",
      installedVersion: "1.2.3",
    });
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

  it("should migrate legacy array store format into the v2 envelope on next save", () => {
    writeFileSync(
      resolve(tmpDir, "agents.json"),
      JSON.stringify([
        {
          skill: {
            name: "legacy-agent",
            description: "legacy",
            metadata: {},
          },
          transport: { type: "stdio", command: "node" },
          installPath: "/tmp/legacy-agent",
          registeredAt: "2026-01-01T00:00:00.000Z",
          status: "idle",
          source: { type: "local", path: "/tmp/legacy-agent" },
        },
      ]),
      "utf-8",
    );

    const agents = store.list();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.source?.type, "local-path");
    assert.equal(agents[0]?.runtime.ownership, "on-demand");

    store.updateStatus("legacy-agent", "online");
    const persisted = JSON.parse(readFileSync(resolve(tmpDir, "agents.json"), "utf-8")) as {
      schemaVersion: number;
      agents: Array<{ source?: { type?: string }; runtime?: { ownership?: string } }>;
    };

    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.agents[0]?.source?.type, "local-path");
    assert.equal(persisted.agents[0]?.runtime?.ownership, "on-demand");
  });

  it("should correct legacy remote source back to local-path when installPath is a local agent dir", () => {
    const localAgentDir = resolve(tmpDir, "browser-use-agent");
    mkdirSync(localAgentDir, { recursive: true });
    writeFileSync(
      resolve(localAgentDir, "SKILL.md"),
      "---\nname: test\ndescription: test\n---\n",
      "utf-8",
    );

    writeFileSync(
      resolve(tmpDir, "agents.json"),
      JSON.stringify([
        {
          skill: {
            name: "browser-use-agent",
            description: "browser",
            metadata: {},
          },
          transport: { type: "streamable-http", endpoint: "http://localhost:3100/mcp" },
          installPath: localAgentDir,
          registeredAt: "2026-01-01T00:00:00.000Z",
          status: "idle",
          source: { type: "remote", endpoint: "http://localhost:3100/mcp" },
        },
      ]),
      "utf-8",
    );

    const agent = store.findByName("browser-use-agent");
    assert.equal(agent?.source?.type, "local-path");
    assert.equal(agent?.runtime.ownership, "external-managed");
  });
});
