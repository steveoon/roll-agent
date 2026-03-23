import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { detectInstallCommand, inferSourceType } from "./update.ts";
import { createDefaultRuntimeForTransport } from "../../types/agent.ts";
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
    runtime: createDefaultRuntimeForTransport(input.transport),
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
      source: { type: "local-path" as const, path: "/home/user/my-agent" },
      transport: { type: "stdio" as const, command: "node" },
      installPath: "/home/user/my-agent",
    });
    assert.equal(inferSourceType(agent), "local-path");
  });

  test("returns remote when source.type is remote", () => {
    const agent = makeAgent({
      source: { type: "remote-manifest" as const, endpoint: "http://localhost:3000/mcp" },
      transport: { type: "streamable-http" as const, endpoint: "http://localhost:3000" },
      installPath: "/tmp/remote-skill",
    });
    assert.equal(inferSourceType(agent), "remote-manifest");
  });

  test("returns installed when source.type is installed", () => {
    const agent = makeAgent({
      source: {
        type: "installed-package" as const,
        packageName: "@roll-agent/smart-reply",
        packageSpec: "@roll-agent/smart-reply@latest",
        installDir: "/tmp/installed/smart-reply",
      },
      transport: { type: "stdio" as const, command: "node" },
      installPath: "/tmp/installed/smart-reply/node_modules/@roll-agent/smart-reply",
    });
    assert.equal(inferSourceType(agent), "installed-package");
  });

  test("falls back to remote for streamable-http without source", () => {
    const agent = makeAgent({
      transport: { type: "streamable-http" as const, endpoint: "http://localhost:3000" },
      installPath: "/tmp/old-agent",
    });
    assert.equal(inferSourceType(agent), "remote-manifest");
  });

  test("falls back to local for stdio without source and without .git dir", () => {
    const tmpPath = resolve(tmpdir(), `roll-update-test-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });
    const agent = makeAgent({
      transport: { type: "stdio" as const, command: "node" },
      installPath: tmpPath,
    });
    try {
      assert.equal(inferSourceType(agent), "local-path");
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

describe("update — detectInstallCommand", () => {
  test("prefers packageManager from package.json", () => {
    const tmpPath = resolve(tmpdir(), `roll-update-install-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });

    try {
      writeFileSync(
        resolve(tmpPath, "package.json"),
        JSON.stringify({ packageManager: "yarn@4.9.1" }, null, 2),
        "utf-8",
      );
      writeFileSync(resolve(tmpPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf-8");

      assert.deepEqual(detectInstallCommand(tmpPath), {
        command: "yarn",
        args: ["install"],
      });
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  test("falls back to pnpm lockfile", () => {
    const tmpPath = resolve(tmpdir(), `roll-update-install-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });

    try {
      writeFileSync(resolve(tmpPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf-8");

      assert.deepEqual(detectInstallCommand(tmpPath), {
        command: "pnpm",
        args: ["install"],
      });
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  test("returns undefined when no package manager hints exist", () => {
    const tmpPath = resolve(tmpdir(), `roll-update-install-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });

    try {
      writeFileSync(resolve(tmpPath, "package.json"), JSON.stringify({ name: "foo" }), "utf-8");
      assert.equal(detectInstallCommand(tmpPath), undefined);
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });
});
