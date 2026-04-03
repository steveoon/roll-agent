import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveDevSpawnSpec, resolveTransportWithDevSpawnSpec } from "./dev-spawn.ts";
import type { RegisteredAgent } from "../types/agent.ts";

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-dev-spawn-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSourceEntry(rootDir: string, relativePath = "src/index.ts"): void {
  const fullPath = resolve(rootDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, "export {};\n", "utf-8");
}

function makeRegisteredAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    skill: {
      name: "smart-reply-agent",
      description: "smart reply",
      metadata: {},
    },
    transport: {
      type: "stdio",
      command: "node",
      args: ["dist/index.js"],
    },
    runtime: {
      ownership: "on-demand",
    },
    installPath: "/tmp/smart-reply-agent",
    registeredAt: new Date().toISOString(),
    status: "idle",
    source: {
      type: "local-path",
      path: "/tmp/smart-reply-agent",
    },
    ...overrides,
  };
}

describe("resolveDevSpawnSpec", () => {
  it("returns src/index.ts fallback for local-path agents", () => {
    const installPath = makeTmpDir();
    try {
      writeSourceEntry(installPath);
      const result = resolveDevSpawnSpec("node", ["dist/index.js"], installPath, "local-path");

      assert.deepEqual(result, {
        command: "node",
        args: ["--experimental-strip-types", "src/index.ts"],
      });
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });

  it("returns src/index.ts fallback for git agents", () => {
    const installPath = makeTmpDir();
    try {
      writeSourceEntry(installPath);
      const result = resolveDevSpawnSpec("node", ["dist/index.js"], installPath, "git");

      assert.deepEqual(result, {
        command: "node",
        args: ["--experimental-strip-types", "src/index.ts"],
      });
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });

  it("skips installed-package and remote-manifest agents", () => {
    const installPath = makeTmpDir();
    try {
      writeSourceEntry(installPath);

      assert.equal(
        resolveDevSpawnSpec("node", ["dist/index.js"], installPath, "installed-package"),
        undefined,
      );
      assert.equal(
        resolveDevSpawnSpec("node", ["dist/index.js"], installPath, "remote-manifest"),
        undefined,
      );
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });

  it("skips non-node and non-dist entrypoints", () => {
    const installPath = makeTmpDir();
    try {
      writeSourceEntry(installPath);

      assert.equal(resolveDevSpawnSpec("bun", ["dist/index.js"], installPath, "local-path"), undefined);
      assert.equal(resolveDevSpawnSpec("node", ["src/index.ts"], installPath, "local-path"), undefined);
      assert.equal(
        resolveDevSpawnSpec("node", ["--trace-warnings", "dist/index.js"], installPath, "local-path"),
        undefined,
      );
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });

  it("skips when source entry does not exist", () => {
    const installPath = makeTmpDir();
    try {
      assert.equal(resolveDevSpawnSpec("node", ["dist/index.js"], installPath, "local-path"), undefined);
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });
});

describe("resolveTransportWithDevSpawnSpec", () => {
  it("rewrites stdio transport for local development agents", () => {
    const installPath = makeTmpDir();
    try {
      writeSourceEntry(installPath);
      const agent = makeRegisteredAgent({
        installPath,
        source: { type: "local-path", path: installPath },
      });

      const transport = resolveTransportWithDevSpawnSpec(agent);

      assert.deepEqual(transport, {
        type: "stdio",
        command: "node",
        args: ["--experimental-strip-types", "src/index.ts"],
      });
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });
});
