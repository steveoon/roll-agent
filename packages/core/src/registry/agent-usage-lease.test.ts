import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  type PathLike,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, mock } from "node:test";
import { McpClientManager } from "../mcp/client-manager.ts";
import {
  AgentUsageBusyError,
  acquireAgentUsageLease,
  acquireAgentUsageMaintenanceGuard,
} from "./agent-usage-lease.ts";
import {
  MANAGED_AGENT_RUNTIME_RETENTIONS,
  acquireAgentLifecycleLock,
  promoteManagedAgentRuntimeToPersistent,
  readVerifiedManagedAgentRuntime,
  stopAgentGracefully,
  writeAgentRuntimeSidecar,
} from "./process-manager.ts";
import type { RegisteredAgent } from "../types/agent.ts";

describe("Agent usage leases", () => {
  it("cancels lifecycle-lock retry before creating a lease", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    const lifecycleLock = acquireAgentLifecycleLock(fixture.dataDir, fixture.agent.skill.name);
    const abortController = new AbortController();
    const abortReason = new Error("bootstrap timed out");
    try {
      const acquiring = acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
        lifecycleLockTimeoutMs: 60_000,
        signal: abortController.signal,
      });
      abortController.abort(abortReason);

      await assert.rejects(acquiring, (error: unknown) => error === abortReason);
      assert.deepEqual(findLeasePaths(fixture), []);
    } finally {
      lifecycleLock.release();
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("releases only the newly acquired lease when readiness is canceled", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    const existingLease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
      holderKind: "run",
      startIfStopped: false,
      waitUntilReady: false,
    });
    assert.ok(existingLease);
    const existingLeasePath = leasePathFor(fixture, existingLease.leaseId);
    const readinessStarted = Promise.withResolvers<void>();
    const abortController = new AbortController();
    const abortReason = new Error("engine closing");
    let observedSignal: AbortSignal | undefined;

    const connectMock = mock.method(
      McpClientManager.prototype,
      "connect",
      async (...args: Parameters<McpClientManager["connect"]>): Promise<never> => {
        const signal = args[3]?.signal;
        observedSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          readinessStarted.resolve();
        });
      },
    );
    const disconnectMock = mock.method(McpClientManager.prototype, "disconnectAll", async () => {});

    try {
      const acquiring = acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: true,
        signal: abortController.signal,
      });
      await readinessStarted.promise;
      assert.equal(findLeasePaths(fixture).length, 2);

      abortController.abort(abortReason);

      await assert.rejects(acquiring, (error: unknown) => error === abortReason);
      assert.equal(observedSignal, abortController.signal);
      assert.equal(existsSync(existingLeasePath), true);
      assert.deepEqual(findLeasePaths(fixture), [existingLeasePath]);
    } finally {
      disconnectMock.mock.restore();
      connectMock.mock.restore();
      await existingLease.release().catch(() => {});
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("keeps a lease-bound Agent alive until the last lease releases", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);
    try {
      const first = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
      });
      const second = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.leaseId, second.leaseId);

      await first.release();
      assert.equal(isChildAlive(fixture.child), true);

      await second.release();
      assert.equal(isChildAlive(fixture.child), false);
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("coordinates lease-bound lifetime across two independent Roll processes", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);
    const firstHolder = spawnLeaseHolder(fixture);
    const secondHolder = spawnLeaseHolder(fixture);
    try {
      await Promise.all([
        waitForHolderMessage(firstHolder, "acquired"),
        waitForHolderMessage(secondHolder, "acquired"),
      ]);

      firstHolder.send?.("release");
      await waitForHolderMessage(firstHolder, "released");
      assert.equal(isChildAlive(fixture.child), true);

      secondHolder.send?.("release");
      await waitForHolderMessage(secondHolder, "released");
      assert.equal(isChildAlive(fixture.child), false);
    } finally {
      if (firstHolder.exitCode === null) firstHolder.kill("SIGKILL");
      if (secondHolder.exitCode === null) secondHolder.kill("SIGKILL");
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("does not stop a persistent Agent when its last lease releases", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    try {
      const lease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "run",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(lease);

      await lease.release();
      assert.equal(isChildAlive(fixture.child), true);
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("keeps readiness and lease-release failures when cleanup cannot quarantine the lease", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);
    const readinessEnvNames = [
      "ROLL_AGENT_READY_STARTUP_TIMEOUT_MS",
      "ROLL_AGENT_READY_PROBE_TIMEOUT_MS",
      "ROLL_AGENT_READY_INTERVAL_MS",
    ] as const;
    const previousEnv = new Map(
      readinessEnvNames.map((name) => [name, process.env[name]] as const),
    );
    for (const name of readinessEnvNames) process.env[name] = "1";

    const releaseError = new Error("lease quarantine failed");
    const originalRenameSync = fs.renameSync;
    const renameMock = mock.method(
      fs,
      "renameSync",
      (sourcePath: PathLike, destinationPath: PathLike) => {
        if (String(destinationPath).endsWith(".releasing.json")) {
          throw releaseError;
        }
        originalRenameSync(sourcePath, destinationPath);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
          holderKind: "chat",
          startIfStopped: false,
          waitUntilReady: true,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.match(error.message, /readiness 检查失败，且使用租约释放失败/u);
          assert.equal(error.errors.length, 2);
          assert.match(String(error.errors[0]), /did not become ready/u);
          assert.equal(error.errors[1], releaseError);
          return true;
        },
      );
      assert.equal(isChildAlive(fixture.child), true);
    } finally {
      renameMock.mock.restore();
      syncBuiltinESMExports();
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("rolls back the exact cold-started runtime when lease persistence fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-agent-usage-cold-start-"));
    const agent = createColdStartAgent(dataDir);
    const leaseWriteError = new Error("lease write failed");
    const originalWriteFileSync = fs.writeFileSync;
    const writeMock = mock.method(
      fs,
      "writeFileSync",
      (...args: Parameters<typeof writeFileSync>) => {
        if (String(args[0]).includes(join("pids", ".leases"))) {
          throw leaseWriteError;
        }
        Reflect.apply(originalWriteFileSync, fs, args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        acquireAgentUsageLease(agent, dataDir, undefined, {
          holderKind: "run",
          startIfStopped: true,
          waitUntilReady: false,
        }),
        leaseWriteError,
      );
      assert.equal(readVerifiedManagedAgentRuntime(dataDir, agent.skill.name), undefined);
    } finally {
      writeMock.mock.restore();
      syncBuiltinESMExports();
      await stopAgentGracefully(dataDir, agent.skill.name).catch(() => {});
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects maintenance while a verified lease is active", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    try {
      const lease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "ask",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(lease);

      await assert.rejects(
        acquireAgentUsageMaintenanceGuard(fixture.agent, fixture.dataDir),
        (error: unknown) => {
          assert.ok(error instanceof AgentUsageBusyError);
          assert.equal(error.blockers[0]?.kind, "active");
          assert.match(error.message, /ask/u);
          return true;
        },
      );

      await lease.release();
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("does not discard an active lease when runtime PID metadata is missing", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    const pidPath = join(fixture.dataDir, "pids", `${fixture.agent.skill.name}.pid`);
    try {
      const lease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(lease);
      unlinkSync(pidPath);

      await assert.rejects(
        acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
          holderKind: "chat",
          startIfStopped: true,
          waitUntilReady: false,
        }),
        AgentUsageBusyError,
      );

      assert.ok(fixture.child.pid);
      writeFileSync(pidPath, String(fixture.child.pid), "utf-8");
      await lease.release();
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("does not join a runtime that differs from an active lease runtime", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    try {
      const lease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(lease);
      assert.ok(fixture.child.pid);
      await new Promise((resolve) => setTimeout(resolve, 2));
      writeAgentRuntimeSidecar(fixture.agent, fixture.dataDir, fixture.child.pid, {
        retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
      });

      await assert.rejects(
        acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
          holderKind: "run",
          startIfStopped: false,
          waitUntilReady: false,
        }),
        AgentUsageBusyError,
      );

      await lease.release();
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("prunes a lease whose owner PID is proven stale", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    const staleLeasePath = writeLeaseFixture(fixture, {
      ownerPid: 2_147_483_647,
      ownerToken: `pst-v2:${"0".repeat(64)}`,
    });
    try {
      const guard = await acquireAgentUsageMaintenanceGuard(fixture.agent, fixture.dataDir);
      assert.ok(guard);
      guard.release();

      assert.equal(existsSync(staleLeasePath), false);
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("releases its own corrupted lease when the file identity is unchanged", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);
    try {
      const lease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(lease);
      const leasePath = leasePathFor(fixture, lease.leaseId);
      const before = lstatSync(leasePath, { bigint: true });

      writeFileSync(leasePath, "{broken-json\n", "utf-8");
      const after = lstatSync(leasePath, { bigint: true });
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);

      await lease.release();

      assert.equal(existsSync(leasePath), false);
      assert.equal(isChildAlive(fixture.child), false);
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("does not delete or stop when its lease file inode was replaced", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);
    try {
      const lease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(lease);
      const leasePath = leasePathFor(fixture, lease.leaseId);
      const original = lstatSync(leasePath, { bigint: true });
      const replacementPath = `${leasePath}.replacement`;
      writeFileSync(
        replacementPath,
        `${JSON.stringify({
          schemaVersion: 1,
          leaseId: lease.leaseId,
          agentName: fixture.agent.skill.name,
          holderKind: "chat",
          ownerIdentity: {
            pid: 2_147_483_647,
            processStartToken: `pst-v2:${"0".repeat(64)}`,
          },
          runtimeIdentity: lease.runtimeIdentity,
          acquiredAt: new Date().toISOString(),
        })}\n`,
        "utf-8",
      );
      const replacement = lstatSync(replacementPath, { bigint: true });
      assert.notEqual(replacement.ino, original.ino);
      unlinkSync(leasePath);
      renameSync(replacementPath, leasePath);

      await lease.release();

      assert.equal(existsSync(leasePath), false);
      assert.equal(isChildAlive(fixture.child), true);
      const quarantinePaths = findReleaseQuarantinePaths(fixture);
      assert.equal(quarantinePaths.length, 1);
      await assert.rejects(
        acquireAgentUsageMaintenanceGuard(fixture.agent, fixture.dataDir),
        (error: unknown) => {
          assert.ok(error instanceof AgentUsageBusyError);
          assert.deepEqual(error.blockers, [
            { kind: "invalid", filePath: quarantinePaths[0] as string },
          ]);
          return true;
        },
      );
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("keeps a replacement created after atomic quarantine as a blocker", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);
    try {
      const lease = await acquireAgentUsageLease(fixture.agent, fixture.dataDir, undefined, {
        holderKind: "chat",
        startIfStopped: false,
        waitUntilReady: false,
      });
      assert.ok(lease);
      const leasePath = leasePathFor(fixture, lease.leaseId);
      const replacementPath = `${leasePath}.replacement`;
      writeFileSync(replacementPath, "{replacement-json\n", "utf-8");

      const originalRenameSync = fs.renameSync;
      let replacementInjected = false;
      const renameMock = mock.method(
        fs,
        "renameSync",
        (sourcePath: PathLike, destinationPath: PathLike) => {
          originalRenameSync(sourcePath, destinationPath);
          if (
            !replacementInjected &&
            String(sourcePath) === leasePath &&
            String(destinationPath).endsWith(".releasing.json")
          ) {
            replacementInjected = true;
            originalRenameSync(replacementPath, leasePath);
          }
        },
      );
      syncBuiltinESMExports();
      try {
        await lease.release();
      } finally {
        renameMock.mock.restore();
        syncBuiltinESMExports();
      }

      assert.equal(replacementInjected, true);
      assert.equal(existsSync(leasePath), true);
      assert.equal(isChildAlive(fixture.child), true);
      assert.deepEqual(findReleaseQuarantinePaths(fixture), []);
      await assert.rejects(
        acquireAgentUsageMaintenanceGuard(fixture.agent, fixture.dataDir),
        (error: unknown) => {
          assert.ok(error instanceof AgentUsageBusyError);
          assert.deepEqual(error.blockers, [{ kind: "invalid", filePath: leasePath }]);
          return true;
        },
      );
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("does not age out an invalid JSON lease", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    const invalidLeasePath = writeInvalidLeaseFixture(fixture, "{broken-json\n");
    const oldTimestamp = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(invalidLeasePath, oldTimestamp, oldTimestamp);
    try {
      await assert.rejects(
        acquireAgentUsageMaintenanceGuard(fixture.agent, fixture.dataDir),
        (error: unknown) => {
          assert.ok(error instanceof AgentUsageBusyError);
          assert.deepEqual(error.blockers, [{ kind: "invalid", filePath: invalidLeasePath }]);
          assert.match(error.message, /关闭所有相关 Roll 进程/u);
          assert.match(error.message, new RegExp(escapeRegExp(invalidLeasePath), "u"));
          return true;
        },
      );
      assert.equal(existsSync(invalidLeasePath), true);
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("keeps an unknown lease schema as an invalid blocker", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    const unknownLeasePath = writeLeaseFixture(
      fixture,
      {
        ownerPid: 2_147_483_647,
        ownerToken: `pst-v2:${"0".repeat(64)}`,
      },
      { schemaVersion: 2 },
    );
    try {
      await assert.rejects(
        acquireAgentUsageMaintenanceGuard(fixture.agent, fixture.dataDir),
        AgentUsageBusyError,
      );
      assert.equal(existsSync(unknownLeasePath), true);
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });

  it("promotes a lease-bound runtime to persistent without replacing its PID", async () => {
    const fixture = await createRuntimeFixture(MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);
    try {
      const before = readVerifiedManagedAgentRuntime(fixture.dataDir, fixture.agent.skill.name);
      assert.ok(before);
      assert.equal(before.retention, MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound);

      assert.equal(
        promoteManagedAgentRuntimeToPersistent(fixture.dataDir, fixture.agent.skill.name),
        true,
      );

      const after = readVerifiedManagedAgentRuntime(fixture.dataDir, fixture.agent.skill.name);
      assert.ok(after);
      assert.equal(after.identity.pid, before.identity.pid);
      assert.equal(after.retention, MANAGED_AGENT_RUNTIME_RETENTIONS.persistent);
    } finally {
      await cleanupRuntimeFixture(fixture);
    }
  });
});

interface RuntimeFixture {
  readonly dataDir: string;
  readonly agent: RegisteredAgent;
  readonly child: ChildProcess;
}

async function createRuntimeFixture(
  retention: (typeof MANAGED_AGENT_RUNTIME_RETENTIONS)[keyof typeof MANAGED_AGENT_RUNTIME_RETENTIONS],
): Promise<RuntimeFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "roll-agent-usage-"));
  const agent = createCoreManagedAgent();
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>process.exit(0));process.send?.('ready');setInterval(()=>{},1000)",
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  await once(child, "message");
  assert.ok(child.pid);

  const pidDirectory = join(dataDir, "pids");
  mkdirSync(pidDirectory, { recursive: true });
  writeFileSync(join(pidDirectory, `${agent.skill.name}.pid`), String(child.pid), "utf-8");
  writeAgentRuntimeSidecar(agent, dataDir, child.pid, { retention });
  return { dataDir, agent, child };
}

async function cleanupRuntimeFixture(fixture: RuntimeFixture): Promise<void> {
  if (isChildAlive(fixture.child)) {
    await stopAgentGracefully(fixture.dataDir, fixture.agent.skill.name, {
      timeoutMs: 2_000,
      intervalMs: 10,
    }).catch(() => {
      fixture.child.kill("SIGKILL");
    });
  }
  rmSync(fixture.dataDir, { recursive: true, force: true });
}

function writeLeaseFixture(
  fixture: RuntimeFixture,
  owner: { readonly ownerPid: number; readonly ownerToken: string },
  options: { readonly schemaVersion?: number } = {},
): string {
  const runtime = readVerifiedManagedAgentRuntime(fixture.dataDir, fixture.agent.skill.name);
  assert.ok(runtime);
  const leaseId = randomUUID();
  const leasePath = leasePathFor(fixture, leaseId);
  mkdirSync(dirname(leasePath), { recursive: true });
  writeFileSync(
    leasePath,
    `${JSON.stringify({
      schemaVersion: options.schemaVersion ?? 1,
      leaseId,
      agentName: fixture.agent.skill.name,
      holderKind: "chat",
      ownerIdentity: {
        pid: owner.ownerPid,
        processStartToken: owner.ownerToken,
      },
      runtimeIdentity: runtime.identity,
      acquiredAt: new Date().toISOString(),
    })}\n`,
    "utf-8",
  );
  return leasePath;
}

function writeInvalidLeaseFixture(fixture: RuntimeFixture, contents: string): string {
  const leasePath = leasePathFor(fixture, randomUUID());
  mkdirSync(dirname(leasePath), { recursive: true });
  writeFileSync(leasePath, contents, "utf-8");
  return leasePath;
}

function leasePathFor(fixture: RuntimeFixture, leaseId: string): string {
  const digest = createHash("sha256").update(fixture.agent.skill.name).digest("hex");
  return join(fixture.dataDir, "pids", ".leases", digest, `${leaseId}.json`);
}

function findReleaseQuarantinePaths(fixture: RuntimeFixture): readonly string[] {
  const leaseDir = dirname(leasePathFor(fixture, randomUUID()));
  if (!existsSync(leaseDir)) return [];
  return readdirSync(leaseDir)
    .filter((fileName) => fileName.endsWith(".releasing.json"))
    .map((fileName) => join(leaseDir, fileName));
}

function findLeasePaths(fixture: RuntimeFixture): readonly string[] {
  const leaseDir = dirname(leasePathFor(fixture, randomUUID()));
  if (!existsSync(leaseDir)) return [];
  return readdirSync(leaseDir)
    .filter((fileName) => !fileName.startsWith(".") && fileName.endsWith(".json"))
    .map((fileName) => join(leaseDir, fileName))
    .sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createCoreManagedAgent(): RegisteredAgent {
  return {
    skill: {
      name: "browser-use-agent",
      description: "Browser use agent",
      metadata: {},
    },
    transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4321/mcp" },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: "/mcp", port: 4321 },
    },
    installPath: "/tmp/browser-use-agent",
    registeredAt: new Date().toISOString(),
    status: "online",
  };
}

function createColdStartAgent(dataDir: string): RegisteredAgent {
  return {
    ...createCoreManagedAgent(),
    skill: {
      name: "cold-start-agent",
      description: "Cold-start Agent",
      metadata: {},
    },
    transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4322/mcp" },
    runtime: {
      ownership: "core-managed",
      start: {
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      },
      endpoint: { path: "/mcp", port: 4322 },
    },
    installPath: dataDir,
    status: "stopped",
  };
}

function isChildAlive(child: ChildProcess): boolean {
  if (child.pid === undefined || child.exitCode !== null) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnLeaseHolder(fixture: RuntimeFixture): ChildProcess {
  const script = `
const { acquireAgentUsageLease } = await import(process.env.ROLL_TEST_LEASE_MODULE);
const agent = JSON.parse(process.env.ROLL_TEST_AGENT);
const lease = await acquireAgentUsageLease(
  agent,
  process.env.ROLL_TEST_DATA_DIR,
  undefined,
  { holderKind: "chat", startIfStopped: false, waitUntilReady: false },
);
if (lease === undefined) throw new Error("expected managed Agent lease");
process.send?.("acquired");
process.on("message", async (message) => {
  if (message !== "release") return;
  try {
    await lease.release();
    process.send?.("released", () => process.exit(0));
  } catch (error) {
    process.send?.({ type: "error", message: String(error) }, () => process.exit(1));
  }
});
`;
  return spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        ROLL_TEST_LEASE_MODULE: new URL("./agent-usage-lease.ts", import.meta.url).href,
        ROLL_TEST_AGENT: JSON.stringify(fixture.agent),
        ROLL_TEST_DATA_DIR: fixture.dataDir,
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
}

async function waitForHolderMessage(
  child: ChildProcess,
  expected: "acquired" | "released",
): Promise<void> {
  const [message] = await once(child, "message");
  assert.equal(
    message,
    expected,
    typeof message === "object" ? JSON.stringify(message) : String(message),
  );
}
