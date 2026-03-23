import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runAgentSetup } from "./runtime-setup.ts";
import type { RegisteredAgent } from "../types/agent.ts";

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-setup-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCoreManagedAgent(installPath: string): RegisteredAgent {
  return {
    skill: {
      name: "browser-use-agent",
      description: "browser agent",
      metadata: {},
    },
    transport: {
      type: "streamable-http",
      endpoint: "http://127.0.0.1:3100/mcp",
    },
    runtime: {
      ownership: "core-managed",
      start: {
        command: "node",
        args: ["dist/index.js"],
      },
      endpoint: {
        path: "/mcp",
        port: 3100,
      },
      setup: {
        playwright: {
          browsers: ["chromium"],
        },
      },
    },
    installPath,
    registeredAt: new Date().toISOString(),
    status: "idle",
    source: {
      type: "local-path",
      path: installPath,
    },
  };
}

describe("runAgentSetup", () => {
  it("returns skipped when agent has no setup steps", async () => {
    const installPath = makeTmpDir();
    try {
      const result = await runAgentSetup({
        ...makeCoreManagedAgent(installPath),
        runtime: {
          ownership: "core-managed",
          start: {
            command: "node",
            args: ["dist/index.js"],
          },
          endpoint: {
            path: "/mcp",
            port: 3100,
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });

  it("returns skipped when browser setup is explicitly disabled", async () => {
    const installPath = makeTmpDir();
    try {
      const result = await runAgentSetup(makeCoreManagedAgent(installPath), {
        skipBrowserSetup: true,
      });

      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.match(result.message, /跳过/);
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });

  it("fails gracefully when playwright-core cli cannot be resolved", async () => {
    const installPath = makeTmpDir();
    try {
      writeFileSync(
        resolve(installPath, "package.json"),
        JSON.stringify({
          name: "browser-use-agent",
          version: "0.0.1",
          type: "module",
        }),
        "utf-8",
      );

      const result = await runAgentSetup(makeCoreManagedAgent(installPath));
      assert.equal(result.ok, false);
      assert.equal(result.skipped, false);
      assert.match(result.message, /playwright-core CLI/);
    } finally {
      rmSync(installPath, { recursive: true, force: true });
    }
  });
});
