import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ScheduleStore } from "@roll-agent/runtime";
import { readProcessStartToken } from "../registry/process-identity.ts";
import { probeExecutorLiveness } from "../scheduler-host/executor-liveness.ts";
import {
  buildConfigYaml,
  formatSpawnedRollProcess,
  isProcessAlive,
  runRoll,
  spawnRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
} from "./smoke.e2e-harness.ts";

function setupWorkspace(): { readonly workspace: string; readonly env: Record<string, string> } {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-schedule-${randomUUID()}-`));
  const dataDir = resolve(workspace, "agents");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    resolve(workspace, "roll.config.yaml"),
    `${buildConfigYaml(dataDir)}
scheduler:
  data-dir: ${resolve(workspace, "scheduler")}
`,
  );
  return { workspace, env: { HOME: workspace } };
}

test("e2e smoke: roll schedule add/list/pause/resume/remove --json", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const added = runRoll(
      [
        "schedule",
        "add",
        "检查未读并汇总",
        "--name",
        "巡检",
        "--every",
        "30m",
        "--cwd",
        workspace,
        "--json",
      ],
      workspace,
      { env },
    );
    assert.equal(added.status, 0, added.stderr);
    const created = JSON.parse(added.stdout) as { id: string; status: string; nextRunAt: string };
    assert.equal(created.status, "active");
    assert.ok(Date.parse(created.nextRunAt) > Date.now() + 29 * 60_000);

    const listed = runRoll(["schedule", "list", "--json"], workspace, { env });
    assert.equal(listed.status, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout) as Array<{ id: string; trigger: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, created.id);
    assert.equal(rows[0]?.trigger, "每 30 分钟");

    assert.equal(runRoll(["schedule", "pause", created.id], workspace, { env }).status, 0);
    const shown = runRoll(["schedule", "show", created.id, "--json"], workspace, { env });
    assert.equal((JSON.parse(shown.stdout) as { status: string }).status, "paused");
    assert.equal(runRoll(["schedule", "resume", created.id], workspace, { env }).status, 0);

    const runs = runRoll(["schedule", "runs", created.id, "--json"], workspace, { env });
    assert.equal(runs.status, 0, runs.stderr);
    assert.deepEqual(JSON.parse(runs.stdout), []);

    assert.equal(runRoll(["schedule", "remove", created.id], workspace, { env }).status, 0);
    const empty = runRoll(["schedule", "list", "--json"], workspace, { env });
    assert.deepEqual(JSON.parse(empty.stdout), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll schedule add 拒绝低于 60 秒的间隔与不存在的 cwd", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const tooFast = runRoll(
      ["schedule", "add", "x", "--name", "快", "--every", "30s", "--cwd", workspace],
      workspace,
      { env },
    );
    assert.equal(tooFast.status, 1);
    assert.match(tooFast.stderr, /60/u);
    const missingCwd = runRoll(
      [
        "schedule",
        "add",
        "x",
        "--name",
        "无目录",
        "--every",
        "5m",
        "--cwd",
        resolve(workspace, "nope"),
      ],
      workspace,
      { env },
    );
    assert.equal(missingCwd.status, 1);
    assert.match(missingCwd.stderr, /cwd/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll --help 列出 schedule", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const result = runRoll(["--help"], workspace, { env });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\bschedule\b/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

interface InvocationJson {
  readonly id: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly executorPid?: number;
  readonly error?: string;
}

test("e2e: run-now --inline 在其他 cwd 的配置下执行，结果仍写回登记时的账本且失败退出码为 1", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const other = resolve(workspace, "other-project");
    mkdirSync(resolve(other, "agents"), { recursive: true });
    writeFileSync(
      resolve(other, "roll.config.yaml"),
      `${buildConfigYaml(resolve(other, "agents"))}
scheduler:
  data-dir: ${resolve(other, "scheduler")}
`,
    );
    const added = runRoll(
      ["schedule", "add", "汇总", "--name", "跨目录", "--every", "1h", "--cwd", other, "--json"],
      workspace,
      { env },
    );
    assert.equal(added.status, 0, added.stderr);
    const created = JSON.parse(added.stdout) as { id: string; authorityDigest?: string };
    assert.match(created.authorityDigest ?? "", /^v1:[a-f0-9]{64}$/u);

    const ran = runRoll(["schedule", "run-now", created.id, "--inline", "--json"], workspace, {
      env,
    });
    assert.equal(ran.status, 1, `${ran.stdout}\n${ran.stderr}`);
    const invocation = JSON.parse(ran.stdout) as InvocationJson;
    assert.equal(invocation.status, "failed");
    assert.equal(invocation.attempt, 1);
    assert.equal(invocation.maxAttempts, 1);
    assert.equal(typeof invocation.executorPid, "number");
    assert.ok((invocation.error ?? "").length > 0, "error should explain the failure");
    assert.doesNotMatch(invocation.error ?? "", /未写入执行结果/u);

    const runs = runRoll(["schedule", "runs", created.id, "--json"], workspace, { env });
    assert.equal(runs.status, 0, runs.stderr);
    const rows = JSON.parse(runs.stdout) as InvocationJson[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, invocation.id);
    assert.equal(existsSync(resolve(other, "scheduler", "schedules.db")), false);

    const shown = runRoll(["schedule", "show", created.id, "--json"], workspace, { env });
    assert.equal((JSON.parse(shown.stdout) as { status: string }).status, "active");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e: daemon 拉起 exec 子进程并把结果写回账本，SIGTERM 后干净退出", async () => {
  const { workspace, env } = setupWorkspace();
  const schedulerDir = resolve(workspace, "scheduler");
  let daemon: ReturnType<typeof spawnRollProcess> | undefined;
  try {
    const added = runRoll(
      [
        "schedule",
        "add",
        "巡检",
        "--name",
        "daemon-e2e",
        "--every",
        "1h",
        "--now",
        "--cwd",
        workspace,
        "--json",
      ],
      workspace,
      { env },
    );
    assert.equal(added.status, 0, added.stderr);
    const created = JSON.parse(added.stdout) as { id: string };
    daemon = spawnRollProcess(["schedule", "daemon", "--foreground"], workspace, env);
    const handle = daemon;
    let rows: InvocationJson[] = [];
    await waitForSmokeCondition(
      "daemon to run the invocation through a spawned exec child",
      () => {
        const runs = runRoll(["schedule", "runs", created.id, "--json"], workspace, { env });
        rows = runs.status === 0 ? (JSON.parse(runs.stdout) as InvocationJson[]) : [];
        return rows.some((row) => row.status === "retry" || row.status === "failed");
      },
      () => formatSpawnedRollProcess("daemon", handle),
      40_000,
    );
    const settled = rows.find((row) => row.status === "retry" || row.status === "failed");
    assert.ok(settled);
    assert.ok(settled.attempt >= 1);
    assert.equal(typeof settled.executorPid, "number");
    assert.ok((settled.error ?? "").length > 0);
    assert.doesNotMatch(settled.error ?? "", /未写入执行结果/u);
    assert.equal(existsSync(resolve(schedulerDir, "daemon.json")), true);
    const status = runRoll(["schedule", "status", "--json"], workspace, { env });
    assert.equal(
      (JSON.parse(status.stdout) as { daemon: { liveness: string } }).daemon.liveness,
      "running",
    );
  } finally {
    if (daemon !== undefined) {
      daemon.child.kill("SIGTERM");
      const exit = await waitForSpawnedRollExit(daemon, "daemon", 20_000);
      assert.equal(exit.code, 0, formatSpawnedRollProcess("daemon", daemon));
      assert.equal(existsSync(resolve(schedulerDir, "daemon.json")), false);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e: 登记后修改 runtime.approval 会让下一次执行终态失败并提示 resume；resume 重新授权", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const project = resolve(workspace, "drift-project");
    mkdirSync(resolve(project, "agents"), { recursive: true });
    const baseConfig = buildConfigYaml(resolve(project, "agents"));
    writeFileSync(resolve(project, "roll.config.yaml"), baseConfig);
    const added = runRoll(
      ["schedule", "add", "汇总", "--name", "漂移", "--every", "1h", "--cwd", project, "--json"],
      workspace,
      { env },
    );
    assert.equal(added.status, 0, added.stderr);
    const created = JSON.parse(added.stdout) as { id: string; authorityDigest: string };

    writeFileSync(
      resolve(project, "roll.config.yaml"),
      `${baseConfig}
runtime:
  approval:
    default: auto
`,
    );
    const ran = runRoll(["schedule", "run-now", created.id, "--inline", "--json"], workspace, {
      env,
    });
    assert.equal(ran.status, 1, `${ran.stdout}\n${ran.stderr}`);
    const invocation = JSON.parse(ran.stdout) as InvocationJson;
    assert.equal(invocation.status, "failed");
    assert.match(invocation.error ?? "", /权限边界已变化/u);
    assert.match(invocation.error ?? "", new RegExp(`roll schedule resume ${created.id}`, "u"));

    const resumed = runRoll(["schedule", "resume", created.id], workspace, { env });
    assert.equal(resumed.status, 0, resumed.stderr);
    const shown = runRoll(["schedule", "show", created.id, "--json"], workspace, { env });
    const record = JSON.parse(shown.stdout) as { status: string; authorityDigest: string };
    assert.equal(record.status, "active");
    assert.notEqual(record.authorityDigest, created.authorityDigest);

    const rerun = runRoll(["schedule", "run-now", created.id, "--inline", "--json"], workspace, {
      env,
    });
    const second = JSON.parse(rerun.stdout) as InvocationJson;
    assert.doesNotMatch(second.error ?? "", /权限边界已变化/u);
    assert.match(second.error ?? "", /LLM provider/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e: roll schedule cancel 对排队/运行/不可验证三种状态分别拒绝或取消", async () => {
  const { workspace, env } = setupWorkspace();
  let sleeper: ChildProcess | undefined;
  try {
    const addSchedule = (name: string) => {
      const added = runRoll(
        ["schedule", "add", "汇总", "--name", name, "--every", "1h", "--cwd", workspace, "--json"],
        workspace,
        { env },
      );
      assert.equal(added.status, 0, added.stderr);
      return (JSON.parse(added.stdout) as { id: string }).id;
    };
    const queuedScheduleId = addSchedule("排队");
    const queued = runRoll(["schedule", "run-now", queuedScheduleId, "--json"], workspace, { env });
    assert.equal(queued.status, 0, queued.stderr);
    const pending = JSON.parse(queued.stdout) as InvocationJson;
    assert.equal(pending.status, "pending");
    const cancelled = runRoll(["schedule", "cancel", pending.id, "--json"], workspace, { env });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const after = JSON.parse(cancelled.stdout) as InvocationJson & { killed: boolean };
    assert.equal(after.status, "failed");
    assert.match(after.error ?? "", /已由用户取消/u);
    assert.equal(after.killed, false);
    const again = runRoll(["schedule", "cancel", pending.id], workspace, { env });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /终态/u);

    sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    await delay(300);
    const sleeperPid = sleeper.pid;
    assert.ok(sleeperPid);
    const sleeperToken = readProcessStartToken(sleeperPid);
    assert.ok(sleeperToken, "需要能读取子进程的 OS 启动身份");
    const runningScheduleId = addSchedule("运行中");
    const unknownScheduleId = addSchedule("不可验证");
    const store = new ScheduleStore(resolve(workspace, "scheduler"), {
      executorLiveness: probeExecutorLiveness,
    });
    const seedRunning = (scheduleId: string, executor: { pid: number; startToken: string }) => {
      const manual = store.enqueueManualInvocation(scheduleId);
      const claim = store.claimPendingInvocation(manual.id, "e2e");
      assert.ok(claim);
      store.beginInvocation(manual.id, claim.ownershipToken, Date.now(), executor);
      return manual.id;
    };
    const runningId = seedRunning(runningScheduleId, { pid: sleeperPid, startToken: sleeperToken });
    const unknownId = seedRunning(unknownScheduleId, {
      pid: process.pid,
      startToken: "not-a-token",
    });
    store.close();

    const refused = runRoll(["schedule", "cancel", runningId], workspace, { env });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--kill/u);
    assert.equal(isProcessAlive(sleeperPid), true);

    const killedRun = runRoll(["schedule", "cancel", runningId, "--kill", "--json"], workspace, {
      env,
    });
    assert.equal(killedRun.status, 0, killedRun.stderr);
    const killedJson = JSON.parse(killedRun.stdout) as InvocationJson & { killed: boolean };
    assert.equal(killedJson.status, "failed");
    assert.equal(killedJson.killed, true);
    await once(sleeper, "exit");
    assert.equal(isProcessAlive(sleeperPid), false);

    const unknownRefused = runRoll(["schedule", "cancel", unknownId, "--kill"], workspace, { env });
    assert.equal(unknownRefused.status, 1);
    assert.match(unknownRefused.stderr, /--abandon/u);
    const stillRunning = runRoll(["schedule", "runs", unknownScheduleId, "--json"], workspace, {
      env,
    });
    assert.equal((JSON.parse(stillRunning.stdout) as InvocationJson[])[0]?.status, "running");

    const abandoned = runRoll(["schedule", "cancel", unknownId, "--abandon", "--json"], workspace, {
      env,
    });
    assert.equal(abandoned.status, 0, abandoned.stderr);
    const abandonedJson = JSON.parse(abandoned.stdout) as InvocationJson & { abandoned: boolean };
    assert.equal(abandonedJson.status, "failed");
    assert.equal(abandonedJson.abandoned, true);
    assert.match(abandonedJson.error ?? "", /--abandon/u);
  } finally {
    if (sleeper !== undefined && sleeper.exitCode === null && sleeper.signalCode === null) {
      sleeper.kill("SIGKILL");
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});
