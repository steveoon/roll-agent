import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  runRoll,
  spawnRollProcess,
  spawnNodeScriptProcess,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
  cleanupSpawnedRollProcess,
  countAgentUsageLeaseFiles,
  readAgentPidFile,
  isProcessAlive,
  forceKillProcess,
  getFreeLocalPort,
  readHttpFixtureAgentLog,
  buildConfigYaml,
  createCoreManagedHttpFixtureAgent,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

test(
  "e2e smoke: failed agent start cleans its runtime when registry finalization times out",
  {
    timeout: 180_000,
  },
  async () => {
    const workspace = mkdtempSync(
      resolve(tmpdir(), `roll-start-registry-timeout-${randomUUID()}-`),
    );
    const agentDir = resolve(workspace, "http-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    const lockMarkerPath = resolve(workspace, "registry-lock-held");
    const lockHolderPath = resolve(workspace, "hold-registry-lock.mjs");
    let startProcess: SpawnedRollProcess | undefined;
    let lockHolder: SpawnedRollProcess | undefined;
    let agentPid: number | undefined;

    try {
      const port = await getFreeLocalPort();
      createCoreManagedHttpFixtureAgent(agentDir, port, {
        startupDelayMs: 60_000,
        createBrokenDistEntry: true,
      });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");
      const rollEnv = {
        HOME: workspace,
        USERPROFILE: workspace,
      };

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ...rollEnv, ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(
        addResult.status,
        0,
        `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
      );

      const registryLockModule = resolve(import.meta.dirname, "../registry/agent-registry-lock.ts");
      writeFileSync(
        lockHolderPath,
        `import { writeFileSync } from "node:fs";
import { acquireAgentRegistryLockAsync } from ${JSON.stringify(registryLockModule)};

const lock = await acquireAgentRegistryLockAsync(${JSON.stringify(dataDir)});
writeFileSync(${JSON.stringify(lockMarkerPath)}, "locked", "utf-8");
const release = () => {
  lock.release();
  process.exit(0);
};
process.stdin.once("data", release);
process.once("SIGTERM", release);
setTimeout(release, 45_000);
await new Promise(() => {});
`,
        "utf-8",
      );

      const spawnedStart = spawnRollProcess(
        ["agent", "start", "http-fixture-agent"],
        workspace,
        rollEnv,
      );
      startProcess = spawnedStart;
      const diagnostics = () =>
        [
          `registry lock marker: ${existsSync(lockMarkerPath) ? "present" : "missing"}`,
          `agent PID: ${readAgentPidFile(dataDir, "http-fixture-agent") ?? "<missing>"}`,
          formatSpawnedRollProcess("roll agent start", spawnedStart),
          ...(lockHolder === undefined
            ? []
            : [formatSpawnedRollProcess("registry lock holder", lockHolder)]),
          readHttpFixtureAgentLog(dataDir),
        ].join("\n\n");

      await waitForSmokeCondition(
        "roll agent start to spawn its persistent runtime",
        () => {
          if (spawnedStart.child.exitCode !== null || spawnedStart.child.signalCode !== null) {
            throw new Error(`roll agent start exited before spawning\n${diagnostics()}`);
          }
          return readAgentPidFile(dataDir, "http-fixture-agent") !== undefined;
        },
        diagnostics,
      );

      const agentPidText = readAgentPidFile(dataDir, "http-fixture-agent");
      assert.ok(agentPidText, diagnostics());
      agentPid = Number(agentPidText);
      assert.ok(Number.isSafeInteger(agentPid) && agentPid > 0, diagnostics());

      const spawnedLockHolder = spawnNodeScriptProcess(lockHolderPath, workspace);
      lockHolder = spawnedLockHolder;
      await waitForSmokeCondition(
        "the independent process to hold the registry lock",
        () => {
          if (
            spawnedLockHolder.child.exitCode !== null ||
            spawnedLockHolder.child.signalCode !== null
          ) {
            throw new Error(`registry lock holder exited early\n${diagnostics()}`);
          }
          return existsSync(lockMarkerPath);
        },
        diagnostics,
      );

      const startExit = await waitForSpawnedRollExit(spawnedStart, "roll agent start", 45_000);
      assert.equal(startExit.code, 1, diagnostics());
      assert.match(spawnedStart.output.stderr, /did not become ready within 15000ms/u);
      assert.match(spawnedStart.output.stderr, /已按 runtime identity 安全回收新进程/u);
      assert.match(spawnedStart.output.stderr, /Agent 注册表正在被另一项操作修改/u);
      await waitForSmokeCondition(
        "the failed start runtime to be stopped despite the registry lock",
        () =>
          agentPid !== undefined &&
          !isProcessAlive(agentPid) &&
          readAgentPidFile(dataDir, "http-fixture-agent") === undefined,
        diagnostics,
      );
      assert.equal(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"), 0, diagnostics());
    } finally {
      await cleanupSpawnedRollProcess(startProcess, "roll agent start");
      await cleanupSpawnedRollProcess(lockHolder, "registry lock holder");
      runRoll(["agent", "stop", "http-fixture-agent"], workspace, {
        env: {
          HOME: workspace,
          USERPROFILE: workspace,
        },
      });
      if (agentPid !== undefined && isProcessAlive(agentPid)) {
        forceKillProcess(agentPid);
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
