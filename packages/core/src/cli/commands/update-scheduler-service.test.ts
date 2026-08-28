import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEDULER_UPDATE_RECONCILE_OUTCOMES,
  parseSchedulerServiceRestartOutput,
  reconcileSchedulerServiceAfterUpdate,
} from "./update-scheduler-service.ts";

function run(overrides: { exitCode?: number | null; stdout?: string; stderr?: string } = {}) {
  return async () => ({
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? JSON.stringify({ action: "restart", liveInvocations: 0 }),
    stderr: overrides.stderr ?? "",
  });
}

test("update scheduler reconcile：子进程 restart 成功且退出 0 → restarted", async () => {
  assert.deepEqual(await reconcileSchedulerServiceAfterUpdate(run()), {
    outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.restarted,
  });
});

test("update scheduler reconcile：live invocation 只延后并带上子进程给出的原因", async () => {
  const result = await reconcileSchedulerServiceAfterUpdate(
    run({
      exitCode: 1,
      stdout: JSON.stringify({ action: "refuse-live-runs", liveInvocations: 2, reason: "2 live" }),
    }),
  );
  assert.deepEqual(result, {
    outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.deferred,
    reason: "2 live",
  });
});

test("update scheduler reconcile：未安装 service 是正常 no-op", async () => {
  const result = await reconcileSchedulerServiceAfterUpdate(
    run({ exitCode: 1, stdout: JSON.stringify({ action: "not-installed", liveInvocations: 0 }) }),
  );
  assert.deepEqual(result, { outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.notInstalled });
});

test("update scheduler reconcile：spawn 失败、输出不可解析或退出码非 0 都是 failed", async () => {
  const spawnFailed = await reconcileSchedulerServiceAfterUpdate(async () => {
    throw new Error("spawn ENOENT");
  });
  assert.deepEqual(spawnFailed, {
    outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed,
    error: "spawn ENOENT",
  });
  const garbage = await reconcileSchedulerServiceAfterUpdate(
    run({ exitCode: 1, stdout: "", stderr: "✗ boom" }),
  );
  assert.equal(garbage.outcome, SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed);
  assert.match(garbage.outcome === "failed" ? garbage.error : "", /boom/u);
  const restartedButFailed = await reconcileSchedulerServiceAfterUpdate(
    run({ exitCode: 1, stderr: "install failed" }),
  );
  assert.equal(restartedButFailed.outcome, SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed);
});

test("parseSchedulerServiceRestartOutput 只接受 restart 命令的 --json 形状", () => {
  assert.equal(parseSchedulerServiceRestartOutput("not json"), undefined);
  assert.equal(parseSchedulerServiceRestartOutput(JSON.stringify({ action: "nope" })), undefined);
  assert.deepEqual(
    parseSchedulerServiceRestartOutput(JSON.stringify({ action: "restart", liveInvocations: 1 })),
    { action: "restart", liveInvocations: 1 },
  );
});
