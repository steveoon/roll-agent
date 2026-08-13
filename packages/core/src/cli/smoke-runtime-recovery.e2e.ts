import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  runRoll,
  spawnRollProcess,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
  cleanupSpawnedRollProcess,
  countAgentUsageLeaseFiles,
  readAgentPidFile,
  isProcessAlive,
  forceKillProcess,
  readAgentRuntimeSnapshot,
  writeInterruptedAgentRelease,
  getFreeLocalPort,
  readHttpFixtureAgentLog,
  formatHttpFixtureStartFailure,
  buildConfigYaml,
  createCoreManagedHttpFixtureAgent,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

test("e2e smoke: agent health --json returns empty array when no agents are registered", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-health-empty-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["agent", "health", "--json"], workspace);
    assert.equal(result.status, 0, `agent health --json failed\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), "[]");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test(
  "e2e smoke: failed agent start cleans its runtime after health writes error",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-start-health-race-${randomUUID()}-`));
    const agentDir = resolve(workspace, "http-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    let startProcess: SpawnedRollProcess | undefined;
    let agentPid: number | undefined;

    try {
      const port = await getFreeLocalPort();
      createCoreManagedHttpFixtureAgent(agentDir, port, {
        startupDelayMs: 30_000,
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

      const spawnedStart = spawnRollProcess(
        ["agent", "start", "http-fixture-agent"],
        workspace,
        rollEnv,
      );
      startProcess = spawnedStart;
      const diagnostics = () =>
        [
          `agent PID: ${readAgentPidFile(dataDir, "http-fixture-agent") ?? "<missing>"}`,
          formatSpawnedRollProcess("roll agent start", spawnedStart),
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

      const healthResult = runRoll(["agent", "health", "--json"], workspace, {
        env: rollEnv,
      });
      assert.equal(
        healthResult.status,
        1,
        `health should mark the still-starting Agent as error\nstdout:\n${healthResult.stdout}\nstderr:\n${healthResult.stderr}\n${diagnostics()}`,
      );
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const fixtureHealth = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(fixtureHealth);
      assert.equal(fixtureHealth.healthy, false);
      assert.match(fixtureHealth.message, /进程存在但不可连接/u);
      assert.equal(spawnedStart.child.exitCode, null, diagnostics());

      const startExit = await waitForSpawnedRollExit(spawnedStart, "roll agent start", 25_000);
      assert.equal(startExit.code, 1, diagnostics());
      assert.match(spawnedStart.output.stderr, /did not become ready within 15000ms/u);
      await waitForSmokeCondition(
        "the failed start runtime to be stopped after the health status update",
        () =>
          agentPid !== undefined &&
          !isProcessAlive(agentPid) &&
          readAgentPidFile(dataDir, "http-fixture-agent") === undefined,
        diagnostics,
      );
      assert.equal(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"), 0, diagnostics());
    } finally {
      await cleanupSpawnedRollProcess(startProcess, "roll agent start");
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

test(
  "e2e smoke: core-managed http agent can start, report health, and stop",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-agent-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, {
        shutdownDelayMs: 1_200,
        createBrokenDistEntry: true,
      });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(
        addResult.status,
        0,
        `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
      );

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));
      assert.match(startResult.stderr, /已启动|已在运行/);

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(
        healthResult.status,
        0,
        `agent health failed\nstdout:\n${healthResult.stdout}\nstderr:\n${healthResult.stderr}`,
      );
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const runningEntry = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(runningEntry);
      assert.equal(runningEntry.healthy, true);
      assert.match(runningEntry.message, /运行中|可连接/);

      const stopResult = runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      assert.equal(
        stopResult.status,
        0,
        `agent stop failed\nstdout:\n${stopResult.stdout}\nstderr:\n${stopResult.stderr}`,
      );
      assert.match(stopResult.stderr, /已停止|当前未运行/);

      const healthAfterStopResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(
        healthAfterStopResult.status,
        1,
        `agent health after stop should report unhealthy\nstdout:\n${healthAfterStopResult.stdout}\nstderr:\n${healthAfterStopResult.stderr}`,
      );
      const healthAfterStop = JSON.parse(healthAfterStopResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const stoppedEntry = healthAfterStop.find(
        (entry) => entry.agentName === "http-fixture-agent",
      );
      assert.ok(stoppedEntry);
      assert.equal(stoppedEntry.healthy, false);
      assert.match(stoppedEntry.message, /未运行|PID/);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: agent stop recovers an interrupted lease release only after confirmation",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-recover-${randomUUID()}-`));
    const agentName = "http-fixture-agent";
    let runtimePid: number | undefined;

    try {
      const agentDir = resolve(workspace, agentName);
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", agentName], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));
      const runtime = readAgentRuntimeSnapshot(dataDir, agentName);
      assert.ok(runtime);
      runtimePid = runtime.pid;
      const releasePath = writeInterruptedAgentRelease(dataDir, agentName);

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(healthResult.status, 1, healthResult.stderr);
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
        readonly recovery?: {
          readonly status: string;
          readonly command?: string;
        };
      }>;
      const healthEntry = health.find((entry) => entry.agentName === agentName);
      assert.ok(healthEntry);
      assert.equal(healthEntry.healthy, false);
      assert.equal(healthEntry.recovery?.status, "recoverable");
      assert.equal(healthEntry.recovery?.command, `roll agent stop ${agentName}`);
      assert.match(healthEntry.message, /--recover/u);

      const doctorResult = runRoll(["doctor", "--json", "--fix-plan"], workspace);
      assert.equal(doctorResult.status, 0, doctorResult.stderr);
      const doctorChecks = JSON.parse(doctorResult.stdout) as ReadonlyArray<{
        readonly name: string;
        readonly fix?: string;
        readonly details?: {
          readonly type?: string;
          readonly status?: string;
        };
      }>;
      const leaseCheck = doctorChecks.find(
        (check) => check.name === `Agent usage lease (${agentName})`,
      );
      assert.ok(leaseCheck);
      assert.equal(leaseCheck.details?.type, "agent-usage-stop-recovery");
      assert.equal(leaseCheck.details?.status, "recoverable");
      assert.match(leaseCheck.fix ?? "", /agent stop http-fixture-agent --recover/u);

      const unconfirmedStop = runRoll(["agent", "stop", agentName], workspace);
      assert.equal(unconfirmedStop.status, 1);
      assert.match(unconfirmedStop.stderr, /上次停止未完成/u);
      assert.match(unconfirmedStop.stderr, new RegExp(`Agent\\s+${agentName}`, "u"));
      assert.match(
        unconfirmedStop.stderr,
        new RegExp(`Runtime\\s+PID ${String(runtime.pid)}`, "u"),
      );
      assert.match(unconfirmedStop.stderr, /残留记录\s+1 个/u);
      assert.match(unconfirmedStop.stderr, /中断来源\s+roll chat · PID \d+ 已退出/u);
      assert.match(unconfirmedStop.stderr, /当前状态\s+未发现其他 Roll 进程正在使用此 Agent/u);
      assert.match(unconfirmedStop.stderr, /当前环境无法显示确认菜单/u);
      assert.equal(unconfirmedStop.stderr.includes(releasePath), false);
      assert.doesNotMatch(unconfirmedStop.stderr, /\.releasing\.json/u);
      assert.equal(existsSync(releasePath), true);
      assert.equal(isProcessAlive(runtime.pid), true);

      const recoveredStop = runRoll(["agent", "stop", agentName, "--recover"], workspace);
      assert.equal(
        recoveredStop.status,
        0,
        `agent stop --recover failed\nstdout:\n${recoveredStop.stdout}\nstderr:\n${recoveredStop.stderr}`,
      );
      assert.match(recoveredStop.stderr, /已清理 1 个残留记录并停止/u);
      assert.equal(existsSync(releasePath), false);
      assert.equal(isProcessAlive(runtime.pid), false);
      assert.equal(readAgentPidFile(dataDir, agentName), undefined);
    } finally {
      runRoll(["agent", "stop", agentName, "--recover"], workspace);
      if (runtimePid !== undefined && isProcessAlive(runtimePid)) {
        forceKillProcess(runtimePid);
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: removing a running core-managed http agent stops it and deregisters it",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-remove-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));

      const removeResult = runRoll(["agent", "remove", "http-fixture-agent"], workspace);
      assert.equal(
        removeResult.status,
        0,
        `agent remove failed\nstdout:\n${removeResult.stdout}\nstderr:\n${removeResult.stderr}`,
      );
      assert.match(removeResult.stderr, /已移除/);

      const listResult = runRoll(["agent", "list", "--json"], workspace);
      assert.equal(listResult.status, 0, listResult.stderr);
      const agents = JSON.parse(listResult.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string };
      }>;
      assert.ok(!agents.some((agent) => agent.skill.name === "http-fixture-agent"));
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
