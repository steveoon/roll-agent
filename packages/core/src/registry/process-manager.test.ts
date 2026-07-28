import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpClientManager } from "../mcp/client-manager.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import {
  AgentLifecycleBusyError,
  AgentRuntimeIdentityError,
  acquireAgentLifecycleLock,
  cleanupOrphanAgentRuntimeMetadata,
  getAgentPid,
  getRollCoreVersion,
  inspectManagedAgentRuntime,
  probeAgentEndpoint,
  readVerifiedManagedAgentRuntime,
  stopAgent,
  stopAgentGracefully,
  waitForAgentReady,
  writeAgentRuntimeSidecar,
  type ManagedAgentRuntimeIdentity,
} from "./process-manager.ts";

describe("managed Agent readiness cancellation", () => {
  it("passes the shared signal and remaining budget to MCP connect/listTools, then disconnects", async () => {
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const client = new Client({ name: "readiness-test", version: "0.0.0" });
    const listStarted = Promise.withResolvers<void>();
    const abortController = new AbortController();
    const abortReason = new Error("bootstrap canceled");
    let connectOptions: Parameters<McpClientManager["connect"]>[3] | undefined;
    let listOptions: Parameters<Client["listTools"]>[1] | undefined;
    let disconnectCalls = 0;

    const connectMock = mock.method(
      McpClientManager.prototype,
      "connect",
      async (...args: Parameters<McpClientManager["connect"]>) => {
        connectOptions = args[3];
        return client;
      },
    );
    const listToolsMock = mock.method(
      client,
      "listTools",
      async (...args: Parameters<Client["listTools"]>) => {
        listOptions = args[1];
        return await new Promise<never>((_resolve, reject) => {
          const signal = args[1]?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          listStarted.resolve();
        });
      },
    );
    const disconnectMock = mock.method(McpClientManager.prototype, "disconnectAll", async () => {
      disconnectCalls += 1;
    });

    try {
      const probing = probeAgentEndpoint(agent, {
        timeoutMs: 10_000,
        signal: abortController.signal,
      });
      await listStarted.promise;
      abortController.abort(abortReason);

      await assert.rejects(probing, (error: unknown) => error === abortReason);
      assert.equal(connectOptions?.signal, abortController.signal);
      assert.ok((connectOptions?.timeoutMs ?? 0) > 0);
      assert.ok((connectOptions?.timeoutMs ?? Infinity) <= 10_000);
      assert.equal(listOptions?.signal, abortController.signal);
      assert.ok((listOptions?.timeout ?? 0) > 0);
      assert.ok((listOptions?.timeout ?? Infinity) <= 10_000);
      assert.equal(disconnectCalls, 1);
    } finally {
      disconnectMock.mock.restore();
      listToolsMock.mock.restore();
      connectMock.mock.restore();
    }
  });

  it("cancels the retry interval without wrapping the abort reason", async () => {
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const abortController = new AbortController();
    const abortReason = new Error("engine closing");
    const probeAttempted = Promise.withResolvers<void>();
    let connectCalls = 0;
    let observedSignal: AbortSignal | undefined;

    const connectMock = mock.method(
      McpClientManager.prototype,
      "connect",
      async (...args: Parameters<McpClientManager["connect"]>): Promise<never> => {
        connectCalls += 1;
        observedSignal = args[3]?.signal;
        probeAttempted.resolve();
        throw new Error("not ready");
      },
    );
    const disconnectMock = mock.method(McpClientManager.prototype, "disconnectAll", async () => {});

    try {
      const waiting = waitForAgentReady(agent, {
        startupTimeoutMs: 60_000,
        probeTimeoutMs: 2_000,
        intervalMs: 60_000,
        signal: abortController.signal,
      });
      await probeAttempted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      abortController.abort(abortReason);

      await assert.rejects(waiting, (error: unknown) => error === abortReason);
      assert.equal(observedSignal, abortController.signal);
      assert.equal(connectCalls, 1);
    } finally {
      disconnectMock.mock.restore();
      connectMock.mock.restore();
    }
  });

  it("preserves both cancellation and MCP cleanup failures without retrying", async () => {
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const client = new Client({ name: "readiness-cleanup-test", version: "0.0.0" });
    const listStarted = Promise.withResolvers<void>();
    const abortController = new AbortController();
    const abortReason = new Error("bootstrap canceled");
    const cleanupFailure = new Error("cleanup failed");
    let connectCalls = 0;

    const connectMock = mock.method(
      McpClientManager.prototype,
      "connect",
      async (): Promise<Client> => {
        connectCalls += 1;
        return client;
      },
    );
    const listToolsMock = mock.method(
      client,
      "listTools",
      async (...args: Parameters<Client["listTools"]>): Promise<never> => {
        const signal = args[1]?.signal;
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          listStarted.resolve();
        });
      },
    );
    const disconnectMock = mock.method(
      McpClientManager.prototype,
      "disconnectAll",
      async (): Promise<never> => {
        throw cleanupFailure;
      },
    );

    try {
      const waiting = waitForAgentReady(agent, {
        startupTimeoutMs: 60_000,
        probeTimeoutMs: 60_000,
        intervalMs: 1,
        signal: abortController.signal,
      });
      await listStarted.promise;
      abortController.abort(abortReason);

      await assert.rejects(waiting, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.name, "AgentProbeCleanupError");
        assert.deepEqual(error.errors, [abortReason, cleanupFailure]);
        return true;
      });
      assert.equal(connectCalls, 1);
    } finally {
      disconnectMock.mock.restore();
      listToolsMock.mock.restore();
      connectMock.mock.restore();
    }
  });
});

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

  it("reads legacy v2 sidecars as persistent runtimes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-v2-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    try {
      writePid(dataDir, agent.skill.name, process.pid);
      writeAgentRuntimeSidecar(agent, dataDir, process.pid, {
        retention: "lease-bound",
      });
      const current = inspectManagedAgentRuntime(agent, dataDir).sidecar;
      assert.ok(current);
      const { retention: _retention, ...legacy } = current;
      writeFileSync(
        join(dataDir, "pids", `${agent.skill.name}.runtime.json`),
        `${JSON.stringify({ ...legacy, schemaVersion: 2 })}\n`,
        "utf-8",
      );

      const inspection = inspectManagedAgentRuntime(agent, dataDir);
      assert.equal(inspection.sidecar?.schemaVersion, 2);
      assert.equal(inspection.sidecar?.retention, "persistent");
      assert.equal(
        readVerifiedManagedAgentRuntime(dataDir, agent.skill.name)?.retention,
        "persistent",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports stale sidecar version, endpoint, and pid mismatches", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");

    writePid(dataDir, agent.skill.name, process.pid);
    writeFileSync(
      join(dataDir, "pids", `${agent.skill.name}.runtime.json`),
      JSON.stringify({
        schemaVersion: 2,
        agentName: "unrelated-agent",
        pid: process.pid + 1,
        processStartToken: staleProcessStartToken(),
        coreVersion: "0.0.0-old",
        startedAt: new Date().toISOString(),
        endpoint: "http://127.0.0.1:9999/mcp",
      }),
      "utf-8",
    );

    const inspection = inspectManagedAgentRuntime(agent, dataDir);

    assert.deepEqual(
      inspection.issues.map((issue) => issue.code),
      ["agent-name-mismatch", "pid-mismatch", "version-mismatch", "endpoint-mismatch"],
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

  it("keeps stale metadata intact during a read-only pid status check", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-stale-read-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    try {
      writePid(dataDir, agent.skill.name, 2_147_483_647);
      writeRuntimeSidecarFixture(agent, dataDir, 2_147_483_647);

      assert.equal(getAgentPid(dataDir, agent.skill.name), undefined);
      assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.pid`)), true);
      assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.runtime.json`)), true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not clean replacement metadata while another lifecycle writer owns the lock", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-cleanup-race-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const writerLock = acquireAgentLifecycleLock(dataDir, agent.skill.name);
    try {
      writePid(dataDir, agent.skill.name, process.pid);
      writeAgentRuntimeSidecar(agent, dataDir, process.pid);

      assert.throws(
        () => cleanupOrphanAgentRuntimeMetadata(dataDir, agent.skill.name),
        AgentLifecycleBusyError,
      );
      assert.equal(getAgentPid(dataDir, agent.skill.name), process.pid);
      assert.equal(
        readFileSync(join(dataDir, "pids", `${agent.skill.name}.pid`), "utf-8"),
        String(process.pid),
      );
      assert.equal(inspectManagedAgentRuntime(agent, dataDir).sidecar?.pid, process.pid);
    } finally {
      writerLock.release();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lifecycle lock when its owner pid belongs to a new process instance", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-stale-lock-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const pidDir = join(dataDir, "pids");
    mkdirSync(pidDir, { recursive: true });
    const digest = createHash("sha256").update(agent.skill.name).digest("hex");
    const lockPath = join(pidDir, `.${digest}.lifecycle.lock`);
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        processStartToken: staleProcessStartToken(),
        token: "stale-owner",
        createdAtMs: Date.now(),
      })}\n`,
      "utf-8",
    );

    const lock = acquireAgentLifecycleLock(dataDir, agent.skill.name);
    try {
      assert.equal(existsSync(lockPath), true);
    } finally {
      lock.release();
      assert.equal(existsSync(lockPath), false);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("stopAgentGracefully", () => {
  it("blocks a second cooperative lifecycle operation while the Agent lock is held", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-lock-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    writePid(dataDir, agent.skill.name, 2_147_483_647);
    const lock = acquireAgentLifecycleLock(dataDir, agent.skill.name);
    try {
      await assert.rejects(stopAgentGracefully(dataDir, agent.skill.name), AgentLifecycleBusyError);
    } finally {
      lock.release();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not signal or clean metadata when the recorded identity differs from expectedIdentity", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-stop-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    try {
      writePid(dataDir, agent.skill.name, process.pid);
      writeAgentRuntimeSidecar(agent, dataDir, process.pid);
      const currentIdentity = readRuntimeIdentity(agent, dataDir);

      const stopped = await stopAgentGracefully(dataDir, agent.skill.name, {
        expectedIdentity: { ...currentIdentity, pid: process.pid + 1 },
      });

      assert.equal(stopped, false);
      assert.equal(
        readFileSync(join(dataDir, "pids", `${agent.skill.name}.pid`), "utf-8"),
        String(process.pid),
      );
      assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.runtime.json`)), true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("cleans dead process metadata under the lifecycle lock in both stop paths", async () => {
    for (const [name, stop] of [
      ["immediate", (dataDir: string, agentName: string) => stopAgent(dataDir, agentName)],
      ["graceful", (dataDir: string, agentName: string) => stopAgentGracefully(dataDir, agentName)],
    ] as const) {
      const dataDir = mkdtempSync(join(tmpdir(), `roll-process-manager-${name}-stale-`));
      const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
      try {
        writePid(dataDir, agent.skill.name, 2_147_483_647);
        writeRuntimeSidecarFixture(agent, dataDir, 2_147_483_647);

        assert.equal(await stop(dataDir, agent.skill.name), false);
        assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.pid`)), false);
        assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.runtime.json`)), false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  it("preserves replacement pid and sidecar metadata while the expected process exits", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-replacement-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));process.send('ready');setInterval(()=>{},1000)",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await once(child, "message");
      assert.ok(child.pid);
      writePid(dataDir, agent.skill.name, child.pid);
      writeAgentRuntimeSidecar(agent, dataDir, child.pid);
      const expectedIdentity = readRuntimeIdentity(agent, dataDir);

      const stopping = stopAgentGracefully(dataDir, agent.skill.name, {
        expectedIdentity,
        timeoutMs: 2_000,
        intervalMs: 10,
      });
      writePid(dataDir, agent.skill.name, process.pid);
      writeAgentRuntimeSidecar(agent, dataDir, process.pid);

      assert.equal(await stopping, true);
      assert.equal(
        readFileSync(join(dataDir, "pids", `${agent.skill.name}.pid`), "utf-8"),
        String(process.pid),
      );
      assert.equal(inspectManagedAgentRuntime(agent, dataDir).sidecar?.pid, process.pid);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed for a self-consistent stale sidecar whose live pid belongs to another process", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-pid-reuse-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const child = spawn(
      process.execPath,
      ["-e", "process.send?.('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await once(child, "message");
      assert.ok(child.pid);
      writePid(dataDir, agent.skill.name, child.pid);
      writeRuntimeSidecarFixture(agent, dataDir, child.pid);

      for (const stop of [
        () => stopAgent(dataDir, agent.skill.name),
        () => stopAgentGracefully(dataDir, agent.skill.name),
      ]) {
        await assert.rejects(async () => stop(), AgentRuntimeIdentityError);
        assert.doesNotThrow(() => process.kill(child.pid ?? 0, 0));
        assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.pid`)), true);
        assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.runtime.json`)), true);
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed for a live pid with a legacy sidecar that has no process identity", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-process-manager-legacy-sidecar-"));
    const agent = createCoreManagedAgent("http://127.0.0.1:4321/mcp");
    const child = spawn(
      process.execPath,
      ["-e", "process.send?.('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await once(child, "message");
      assert.ok(child.pid);
      writePid(dataDir, agent.skill.name, child.pid);
      writeFileSync(
        join(dataDir, "pids", `${agent.skill.name}.runtime.json`),
        `${JSON.stringify({
          schemaVersion: 1,
          agentName: agent.skill.name,
          pid: child.pid,
          coreVersion: getRollCoreVersion(),
          startedAt: new Date(0).toISOString(),
          endpoint:
            agent.transport.type === "streamable-http" ? agent.transport.endpoint : undefined,
        })}\n`,
        "utf-8",
      );

      await assert.rejects(
        stopAgentGracefully(dataDir, agent.skill.name),
        AgentRuntimeIdentityError,
      );
      assert.doesNotThrow(() => process.kill(child.pid ?? 0, 0));
      assert.equal(existsSync(join(dataDir, "pids", `${agent.skill.name}.runtime.json`)), true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
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

function writeRuntimeSidecarFixture(agent: RegisteredAgent, dataDir: string, pid: number): void {
  const pidDir = join(dataDir, "pids");
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(
    join(pidDir, `${agent.skill.name}.runtime.json`),
    `${JSON.stringify({
      schemaVersion: 2,
      agentName: agent.skill.name,
      pid,
      processStartToken: staleProcessStartToken(),
      coreVersion: getRollCoreVersion(),
      startedAt: new Date(0).toISOString(),
      endpoint: agent.transport.type === "streamable-http" ? agent.transport.endpoint : undefined,
    })}\n`,
    "utf-8",
  );
}

function readRuntimeIdentity(agent: RegisteredAgent, dataDir: string): ManagedAgentRuntimeIdentity {
  const inspection = inspectManagedAgentRuntime(agent, dataDir);
  assert.ok(inspection.sidecar);
  assert.deepEqual(inspection.issues, []);
  return {
    pid: inspection.sidecar.pid,
    processStartToken: inspection.sidecar.processStartToken,
    startedAt: inspection.sidecar.startedAt,
  };
}

function staleProcessStartToken(): string {
  return `pst-v2:${"0".repeat(64)}`;
}
