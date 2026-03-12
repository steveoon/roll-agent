import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { inferSourceType } from "./update.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

function makeAgent(
  input: Pick<RegisteredAgent, "transport" | "installPath"> &
    Partial<Pick<RegisteredAgent, "source">>,
): RegisteredAgent {
  return {
    skill: {
      name: "test-agent",
      description: "test",
      metadata: {},
    },
    transport: input.transport,
    installPath: input.installPath,
    registeredAt: new Date().toISOString(),
    status: "idle",
    ...(input.source ? { source: input.source } : {}),
  };
}

describe("update — inferSourceType", () => {
  test("returns git when source.type is git", () => {
    const agent = makeAgent({
      source: { type: "git" as const, url: "https://github.com/foo/bar.git" },
      transport: { type: "stdio" as const, command: "node" },
      installPath: "/tmp/bar",
    });
    assert.equal(inferSourceType(agent), "git");
  });

  test("returns local when source.type is local", () => {
    const agent = makeAgent({
      source: { type: "local" as const, path: "/home/user/my-agent" },
      transport: { type: "stdio" as const, command: "node" },
      installPath: "/home/user/my-agent",
    });
    assert.equal(inferSourceType(agent), "local");
  });

  test("returns remote when source.type is remote", () => {
    const agent = makeAgent({
      source: { type: "remote" as const },
      transport: { type: "streamable-http" as const, endpoint: "http://localhost:3000" },
      installPath: "/tmp/remote-skill",
    });
    assert.equal(inferSourceType(agent), "remote");
  });

  test("falls back to remote for streamable-http without source", () => {
    const agent = makeAgent({
      transport: { type: "streamable-http" as const, endpoint: "http://localhost:3000" },
      installPath: "/tmp/old-agent",
    });
    assert.equal(inferSourceType(agent), "remote");
  });

  test("falls back to local for stdio without source and without .git dir", () => {
    const tmpPath = resolve(tmpdir(), `roll-update-test-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });
    const agent = makeAgent({
      transport: { type: "stdio" as const, command: "node" },
      installPath: tmpPath,
    });
    try {
      assert.equal(inferSourceType(agent), "local");
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  test("falls back to git for stdio without source when .git exists", () => {
    const tmpPath = resolve(tmpdir(), `roll-update-test-${randomUUID()}`);
    const gitPath = resolve(tmpPath, ".git");
    mkdirSync(gitPath, { recursive: true });
    const agent = makeAgent({
      transport: { type: "stdio" as const, command: "node" },
      installPath: tmpPath,
    });
    try {
      assert.equal(inferSourceType(agent), "git");
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });
});
