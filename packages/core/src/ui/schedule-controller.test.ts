import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScheduleStore, createIntervalTrigger } from "@roll-agent/runtime";
import {
  RollUiScheduleBusyError,
  RollUiScheduleRequestError,
  createRollUiScheduleController,
  type ScheduleHostPort,
  type ScheduleHostStatus,
} from "./schedule-controller.ts";

const NOW = Date.parse("2026-08-31T09:00:00.000Z");
const DUE = NOW + 1_800_000;

const HOST_STATUS: ScheduleHostStatus = {
  dataDir: "/tmp/roll-sched",
  logPath: "/tmp/roll-sched/scheduler.log",
  daemon: { liveness: "stopped" },
  service: { metadataStatus: "missing", installed: false, running: false },
};

interface FakeHost extends ScheduleHostPort {
  readonly calls: string[];
  release(): void;
}

function createFakeHost(): FakeHost {
  let pending: (() => void) | undefined;
  const calls: string[] = [];
  const gated = (name: string) => async () => {
    calls.push(name);
    await new Promise<void>((resolve) => {
      pending = resolve;
    });
    return { ok: true as const };
  };
  return {
    calls,
    inspect: async () => {
      calls.push("inspect");
      return HOST_STATUS;
    },
    installService: gated("install"),
    restartService: gated("restart"),
    uninstallService: gated("uninstall"),
    release: () => {
      pending?.();
      pending = undefined;
    },
  };
}

function createHarness(dir: string, host: ScheduleHostPort = createFakeHost()) {
  const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
  const controller = createRollUiScheduleController({
    ledger: { open: async () => new ScheduleStore(dir, { executorLiveness: () => "dead" }) },
    host,
    authorityDigestFor: () => "digest-b",
  });
  return { store, controller, close: () => store.close() };
}

function sampleSchedule(store: ScheduleStore, name: string) {
  return store.createSchedule(
    { name, prompt: "检查未读消息", cwd: "/workspace/demo", trigger: createIntervalTrigger("30m") },
    NOW,
  );
}

test("schedule-controller getStatus 合并 host 探测与账本统计", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-controller-"));
  const harness = createHarness(dir);
  try {
    sampleSchedule(harness.store, "任务甲");
    const paused = sampleSchedule(harness.store, "任务乙");
    harness.store.setScheduleStatus(paused.id, "paused", NOW);
    const status = (await harness.controller.getStatus()) as {
      dataDir: string;
      schedules: { total: number; active: number; paused: number };
      service: { installed: boolean };
      nextWakeAt: string | undefined;
    };
    assert.equal(status.dataDir, HOST_STATUS.dataDir);
    assert.deepEqual(status.schedules, { total: 2, active: 1, paused: 1 });
    assert.equal(status.service.installed, false);
    assert.equal(status.nextWakeAt, new Date(DUE).toISOString());
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule-controller listSchedules 输出序列化行与 live run 标记", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-controller-"));
  const harness = createHarness(dir);
  try {
    const schedule = sampleSchedule(harness.store, "任务甲");
    const rows = (await harness.controller.listSchedules()) as Array<{
      id: string;
      name: string;
      status: string;
      trigger: string;
      liveRun: { id: string; status: string } | undefined;
    }>;
    assert.equal(rows.length, 1);
    assert.ok(rows[0]);
    assert.equal(rows[0].id, schedule.id);
    assert.equal(rows[0].name, "任务甲");
    assert.equal(rows[0].liveRun, undefined);

    const [claim] = harness.store.claimDue({ workerId: "w1", nowMs: DUE, limit: 1 });
    assert.ok(claim);
    const claimedRows = (await harness.controller.listSchedules()) as Array<{
      liveRun: { id: string; status: string } | undefined;
    }>;
    assert.deepEqual(claimedRows[0]?.liveRun, { id: claim.invocation.id, status: "claimed" });
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule-controller listRuns 跨任务合并并附任务名", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-controller-"));
  const harness = createHarness(dir);
  try {
    const first = sampleSchedule(harness.store, "任务甲");
    const claims = harness.store.claimDue({ workerId: "w1", nowMs: DUE, limit: 5 });
    assert.equal(claims.length, 1);
    const runs = (await harness.controller.listRuns({})) as Array<{
      id: string;
      scheduleId: string;
      scheduleName: string;
      status: string;
    }>;
    assert.equal(runs.length, 1);
    assert.ok(runs[0]);
    assert.equal(runs[0].scheduleId, first.id);
    assert.equal(runs[0].scheduleName, "任务甲");
    assert.equal(runs[0].status, "claimed");

    const scoped = (await harness.controller.listRuns({
      scheduleId: first.id,
      limit: 5,
    })) as unknown[];
    assert.equal(scoped.length, 1);

    await assert.rejects(
      () => Promise.resolve(harness.controller.listRuns({ limit: 0 })),
      RollUiScheduleRequestError,
    );
    await assert.rejects(
      () => Promise.resolve(harness.controller.listRuns({ scheduleId: 42 })),
      RollUiScheduleRequestError,
    );
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule-controller pause/resume 切换状态并在 resume 时重新授权", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-controller-"));
  const harness = createHarness(dir);
  try {
    const schedule = sampleSchedule(harness.store, "任务甲");
    const pauseResult = (await harness.controller.pauseSchedule({ id: schedule.id })) as {
      ok: boolean;
    };
    assert.equal(pauseResult.ok, true);
    assert.equal(harness.store.getSchedule(schedule.id)?.status, "paused");

    const resumeResult = (await harness.controller.resumeSchedule({ id: schedule.id })) as {
      ok: boolean;
      authorityChanged: boolean;
    };
    assert.equal(resumeResult.ok, true);
    assert.equal(resumeResult.authorityChanged, true);
    const resumed = harness.store.getSchedule(schedule.id);
    assert.equal(resumed?.status, "active");
    assert.equal(resumed?.authorityDigest, "digest-b");

    await assert.rejects(
      () => Promise.resolve(harness.controller.pauseSchedule({ id: "missing" })),
      /不存在/u,
    );
    await assert.rejects(
      () => Promise.resolve(harness.controller.pauseSchedule({})),
      RollUiScheduleRequestError,
    );
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule-controller resume 在任务被并发删除时报错而非假成功", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-controller-"));
  const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
  const controller = createRollUiScheduleController({
    ledger: {
      open: async () => {
        const real = new ScheduleStore(dir, { executorLiveness: () => "dead" });
        return new Proxy(real, {
          get(target, property, receiver) {
            if (property === "resumeSchedule") {
              return () => false;
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
    host: createFakeHost(),
    authorityDigestFor: () => "digest-b",
  });
  const harness = { store, controller, close: () => store.close() };
  try {
    const schedule = sampleSchedule(harness.store, "任务甲");
    harness.store.setScheduleStatus(schedule.id, "paused", NOW);
    await assert.rejects(
      () => Promise.resolve(harness.controller.resumeSchedule({ id: schedule.id })),
      /不存在|已被删除/u,
    );
    assert.equal(harness.store.getSchedule(schedule.id)?.status, "paused");
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule-controller cancelInvocation 走共享取消逻辑", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-controller-"));
  const harness = createHarness(dir);
  try {
    sampleSchedule(harness.store, "任务甲");
    const [claim] = harness.store.claimDue({ workerId: "w1", nowMs: DUE, limit: 1 });
    assert.ok(claim);
    const result = (await harness.controller.cancelInvocation({ id: claim.invocation.id })) as {
      ok: boolean;
      killed: boolean;
      previousStatus: string;
    };
    assert.equal(result.ok, true);
    assert.equal(result.killed, false);
    assert.equal(result.previousStatus, "claimed");
    assert.equal(harness.store.getInvocation(claim.invocation.id)?.status, "failed");

    await assert.rejects(
      () => Promise.resolve(harness.controller.cancelInvocation({ id: 42 })),
      RollUiScheduleRequestError,
    );
    await assert.rejects(
      () =>
        Promise.resolve(
          harness.controller.cancelInvocation({ id: claim.invocation.id, kill: "yes" }),
        ),
      RollUiScheduleRequestError,
    );
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule-controller 写操作互斥且非法请求不占用互斥槽", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "roll-schedule-controller-"));
  const host = createFakeHost();
  const harness = createHarness(dir, host);
  try {
    const schedule = sampleSchedule(harness.store, "任务甲");
    const install = harness.controller.installService();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => Promise.resolve(harness.controller.restartService()),
      RollUiScheduleBusyError,
    );
    await assert.rejects(
      () => Promise.resolve(harness.controller.pauseSchedule({ id: schedule.id })),
      RollUiScheduleBusyError,
    );
    await assert.rejects(
      () => Promise.resolve(harness.controller.pauseSchedule({})),
      RollUiScheduleRequestError,
    );
    host.release();
    await install;
    const pauseResult = (await harness.controller.pauseSchedule({ id: schedule.id })) as {
      ok: boolean;
    };
    assert.equal(pauseResult.ok, true);
    assert.deepEqual(host.calls, ["install"]);
  } finally {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
