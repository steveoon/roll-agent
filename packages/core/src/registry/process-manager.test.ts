import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RegisteredAgent } from "../types/agent.ts";
import {
  cleanupOrphanAgentRuntimeMetadata,
  getRollCoreVersion,
  inspectManagedAgentRuntime,
  writeAgentRuntimeSidecar,
} from "./process-manager.ts";

describe("managed agent runtime sidecar", () => {
  it("reports a clean runtime sidecar for the active pid and endpoint", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");

    writePid(dataDir, agent.skill.name, process.pid);
    writeAgentRuntimeSidecar(agent, dataDir, process.pid);

    const inspection = inspectManagedAgentRuntime(agent, dataDir);

    assert.equal(inspection.pid, process.pid);
    assert.equal(inspection.sidecar?.pid, process.pid);
    assert.equal(inspection.sidecar?.coreVersion, getRollCoreVersion());
    assert.deepEqual(inspection.issues, []);
  });

  it("reports stale sidecar version, endpoint, and pid mismatches", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");

    writePid(dataDir, agent.skill.name, process.pid);
    writeFileSync(
      join(dataDir, "pids", `${agent.skill.name}.runtime.json`),
      JSON.stringify({
        schemaVersion: 1,
        agentName: agent.skill.name,
        pid: process.pid + 1,
        coreVersion: "0.0.0-old",
        startedAt: new Date().toISOString(),
        endpoint: "http://127.0.0.1:9999/mcp",
      }),
      "utf-8",
    );

    const inspection = inspectManagedAgentRuntime(agent, dataDir);

    assert.deepEqual(
      inspection.issues.map((issue) => issue.code),
      ["pid-mismatch", "version-mismatch", "endpoint-mismatch"],
    );
  });

  it("reports and cleans orphan runtime metadata without stopping a process", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");

    writeAgentRuntimeSidecar(agent, dataDir, process.pid);

    const inspection = inspectManagedAgentRuntime(agent, dataDir);
    assert.equal(inspection.pid, undefined);
    assert.equal(inspection.issues[0]?.code, "orphan-sidecar");

    assert.equal(cleanupOrphanAgentRuntimeMetadata(dataDir, agent.skill.name), true);

    assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.runtime.json`)), false);
  });

  it("does not clean runtime metadata when an active pid appears before cleanup", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");

    writePid(dataDir, agent.skill.name, process.pid);
    writeAgentRuntimeSidecar(agent, dataDir, process.pid);

    assert.equal(cleanupOrphanAgentRuntimeMetadata(dataDir, agent.skill.name), false);
    assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.runtime.json`)), true);
  });
});

function createCoreManagedAgent(endpoint: string): RegisteredAgent {
  return {
    skill: {
      name: "browser-use-agent",
      description: "Browser use agent",
      metadata: {},
    },
    transport: { type: "streamable-http", endpoint },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: "/mcp", port: 4321 },
    },
    installPath: "/tmp/browser-use-agent",
    registeredAt: new Date().toISOString(),
    status: "stopped",
  };
}

function writePid(dataDir: string, agentName: string, pid: number): void {
  const pidDir = join(dataDir, "pids");
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(join(pidDir, `${agentName}.pid`), String(pid), "utf-8");
}
