import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduleStore } from "./schedule-store.ts";
import {
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_MODES,
  INVOCATION_STATUSES,
  SCHEDULE_STATUSES,
  SCHEDULE_STORE_ERROR_CODES,
  ScheduleStoreError,
} from "./types.ts";
import { createIntervalTrigger } from "./trigger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-schedules-"));
}

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

function sampleInput(overrides: Partial<Parameters<ScheduleStore["createSchedule"]>[0]> = {}) {
  return {
    name: "每日巡检",
    prompt: "检查未读消息并汇总",
    cwd: "/workspace/demo",
    trigger: createIntervalTrigger("30m"),
    ...overrides,
  };
}

test("ScheduleStore 创建、查询、列出与删除 schedule", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    assert.equal(created.status, SCHEDULE_STATUSES.active);
    assert.equal(created.nextRunAtMs, NOW + 1_800_000);
    assert.equal(created.lastRunAtMs, undefined);
    assert.deepEqual(store.getSchedule(created.id), created);
    assert.deepEqual(
      store.listSchedules().map((s) => s.id),
      [created.id],
    );
    assert.equal(store.removeSchedule(created.id), true);
    assert.equal(store.removeSchedule(created.id), false);
    assert.equal(store.getSchedule(created.id), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fireImmediately 让 nextRunAt 等于 now", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    assert.equal(created.nextRunAtMs, NOW);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause/resume 只改状态不改相位", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 1), true);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, NOW + 1_800_000);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.active, NOW + 2), true);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, NOW + 1_800_000);
    assert.equal(store.setScheduleStatus("missing", SCHEDULE_STATUSES.paused, NOW), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超过 maxSchedules、非法 name/prompt/cwd 都被拒绝", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { maxSchedules: 1 });
    store.createSchedule(sampleInput(), NOW);
    assert.throws(
      () => store.createSchedule(sampleInput({ name: "second" }), NOW),
      (error: unknown) =>
        error instanceof ScheduleStoreError &&
        error.code === SCHEDULE_STORE_ERROR_CODES.limitReached,
    );
    assert.throws(
      () => store.createSchedule(sampleInput({ name: "   " }), NOW),
      ScheduleStoreError,
    );
    assert.throws(
      () => store.createSchedule(sampleInput({ prompt: "x".repeat(4_001) }), NOW),
      ScheduleStoreError,
    );
    assert.throws(
      () => store.createSchedule(sampleInput({ cwd: "relative/path" }), NOW),
      ScheduleStoreError,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ScheduleStore 在 POSIX 上收紧目录与数据库权限", () => {
  if (process.platform === "win32") {
    return;
  }
  const parent = tempDir();
  const dir = join(parent, "nested", "scheduler");
  try {
    chmodSync(parent, 0o755);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const store = new ScheduleStore(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "schedules.db")).mode & 0o777, 0o600);
    store.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("claimDue 为到期 schedule 生成 invocation 并把 nextRunAt 从 now 重锚", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 120_000 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const late = NOW + 4 * 3_600_000;
    const claims = store.claimDue({ workerId: "w1", nowMs: late, limit: 5 });
    assert.equal(claims.length, 1);
    const claim = claims[0];
    assert.ok(claim);
    assert.equal(claim.invocation.status, INVOCATION_STATUSES.claimed);
    assert.equal(claim.invocation.mode, INVOCATION_MODES.scheduled);
    assert.equal(claim.invocation.scheduledForMs, NOW);
    assert.equal(claim.invocation.attempt, 1);
    assert.equal(claim.invocation.claimedBy, "w1");
    assert.equal(claim.invocation.leaseUntilMs, late + 120_000);
    assert.equal(claim.schedule.id, created.id);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, late + 1_800_000);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: late + 1, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimDue 尊重 limit，paused schedule 不触发", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const a = store.createSchedule(sampleInput({ name: "a", fireImmediately: true }), NOW);
    store.createSchedule(sampleInput({ name: "b", fireImmediately: true }), NOW);
    const c = store.createSchedule(sampleInput({ name: "c", fireImmediately: true }), NOW);
    store.setScheduleStatus(c.id, SCHEDULE_STATUSES.paused, NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.schedule.id, a.id);
    const second = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 5 });
    assert.equal(second.length, 1);
    assert.equal(second[0]?.schedule.name, "b");
    assert.deepEqual(store.claimDue({ workerId: "w1", nowMs: NOW, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("begin/renew/complete 都受 ownership token 约束", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(store.beginInvocation(claim.invocation.id, "wrong-token", NOW + 1), undefined);
    const begun = store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1);
    assert.equal(begun?.invocation.status, INVOCATION_STATUSES.running);
    assert.equal(begun?.invocation.startedAtMs, NOW + 1);
    assert.equal(store.renewLease(claim.invocation.id, "wrong-token", NOW + 2), false);
    assert.equal(store.renewLease(claim.invocation.id, claim.ownershipToken, NOW + 2), true);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: "wrong-token",
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 3,
      }),
      false,
    );
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.needsConfirmation,
        nowMs: NOW + 3,
        threadId: "thread-1",
        outputExcerpt: "done",
        pendingActions: ["browser.click"],
      }),
      true,
    );
    const stored = store.getInvocation(claim.invocation.id);
    assert.equal(stored?.status, INVOCATION_STATUSES.needsConfirmation);
    assert.equal(stored?.threadId, "thread-1");
    assert.deepEqual(stored?.pendingActions, ["browser.click"]);
    assert.equal(stored?.claimedBy, undefined);
    assert.equal(stored?.finishedAtMs, NOW + 3);
    assert.equal(store.getSchedule(created.id)?.lastRunAtMs, NOW + 3);
    assert.equal(store.getSchedule(created.id)?.lastError, undefined);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 4,
      }),
      false,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failInvocation 走退避重试，预算耗尽后终态并 pause scheduled 任务", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 2, retryBackoffMs: 10_000 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    assert.equal(
      store.failInvocation(first.invocation.id, "wrong", "boom", NOW + 1),
      INVOCATION_FAILURE_OUTCOMES.lostClaim,
    );
    assert.equal(
      store.failInvocation(first.invocation.id, first.ownershipToken, "boom", NOW + 1),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const afterFirst = store.getInvocation(first.invocation.id);
    assert.equal(afterFirst?.status, INVOCATION_STATUSES.retry);
    assert.equal(afterFirst?.retryAtMs, NOW + 10_001);
    assert.equal(afterFirst?.error, "boom");
    assert.deepEqual(store.claimDue({ workerId: "w1", nowMs: NOW + 5_000, limit: 5 }), []);
    const second = store.claimDue({ workerId: "w1", nowMs: NOW + 11_000, limit: 5 })[0];
    assert.ok(second);
    assert.equal(second.invocation.id, first.invocation.id);
    assert.equal(second.invocation.attempt, 2);
    assert.equal(
      store.failInvocation(second.invocation.id, second.ownershipToken, "boom again", NOW + 12_000),
      INVOCATION_FAILURE_OUTCOMES.terminalPaused,
    );
    assert.equal(store.getInvocation(first.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.match(store.getSchedule(created.id)?.lastError ?? "", /boom again/u);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease 过期的 claimed/running invocation 会被重新 claim 为同一次触发", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000, retryBudget: 3 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 500, limit: 5 }), []);
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 1_001, limit: 5 });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.invocation.id, first.invocation.id);
    assert.equal(reclaimed[0]?.invocation.attempt, 2);
    assert.equal(reclaimed[0]?.invocation.claimedBy, "w2");
    assert.notEqual(reclaimed[0]?.ownershipToken, first.ownershipToken);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 1_002), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual invocation 入队、单独 claim，失败不 pause 计划", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const created = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(created.id, NOW);
    assert.equal(queued.mode, INVOCATION_MODES.manual);
    assert.equal(queued.status, INVOCATION_STATUSES.pending);
    assert.throws(() => store.enqueueManualInvocation("missing", NOW), ScheduleStoreError);
    assert.equal(store.claimPendingInvocation(queued.id, "inline", NOW + 1)?.invocation.attempt, 1);
    assert.equal(store.claimPendingInvocation(queued.id, "inline", NOW + 1), undefined);
    const claimed = store.getInvocation(queued.id);
    assert.equal(claimed?.status, INVOCATION_STATUSES.claimed);
    assert.equal(claimed?.claimedBy, "inline");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual 失败终态不 pause 计划；listInvocations 与 nextWakeAtMs", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const created = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(created.id, NOW);
    assert.equal(store.nextWakeAtMs(), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW + 1, limit: 5 })[0];
    assert.ok(claim);
    assert.equal(claim.invocation.id, queued.id);
    assert.equal(
      store.failInvocation(claim.invocation.id, claim.ownershipToken, "manual boom", NOW + 2),
      INVOCATION_FAILURE_OUTCOMES.terminal,
    );
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.active);
    assert.equal(store.listInvocations(created.id).length, 1);
    assert.equal(store.listInvocations(created.id, 0).length, 0);
    assert.equal(store.nextWakeAtMs(), NOW + 1_800_000);
    store.removeSchedule(created.id);
    assert.equal(store.nextWakeAtMs(), undefined);
    assert.equal(store.listInvocations(created.id).length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running 且 executor 仍存活或未知时 lease 过期只续 lease，不重复执行；executor 已死才 reclaim", () => {
  const dir = tempDir();
  try {
    let liveness: "alive" | "dead" | "unknown" = "alive";
    const probed: number[] = [];
    const store = new ScheduleStore(dir, {
      claimLeaseMs: 1_000,
      executorLiveness: (executor) => {
        probed.push(executor.pid);
        return liveness;
      },
    });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW, {
      pid: 4242,
      startToken: "pst-v2:abc",
    });
    assert.deepEqual(store.getInvocation(first.invocation.id)?.executor, {
      pid: 4242,
      startToken: "pst-v2:abc",
    });
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 1_001, limit: 5 }), []);
    assert.deepEqual(probed, [4242]);
    assert.equal(store.getInvocation(first.invocation.id)?.leaseUntilMs, NOW + 2_001);
    assert.equal(store.getInvocation(first.invocation.id)?.status, INVOCATION_STATUSES.running);
    liveness = "unknown";
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 2_002, limit: 5 }), []);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 2_003), true);
    liveness = "dead";
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 3_100, limit: 5 });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.invocation.id, first.invocation.id);
    assert.equal(reclaimed[0]?.invocation.attempt, 2);
    assert.equal(reclaimed[0]?.invocation.status, INVOCATION_STATUSES.claimed);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 3_101), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没有注入探针时 running 行 lease 过期永不 reclaim（fail-closed）", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW, {
      pid: 1,
      startToken: "pst-v2:abc",
    });
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 60_000, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimed 但尚未 begin 的行 lease 过期照常 reclaim，旧 token 的 begin 被拒绝", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 1_001, limit: 5 });
    assert.equal(reclaimed[0]?.invocation.id, first.invocation.id);
    assert.equal(
      store.beginInvocation(first.invocation.id, first.ownershipToken, NOW + 1_002, {
        pid: 7,
        startToken: "pst-v2:late",
      }),
      undefined,
    );
    assert.equal(store.getInvocation(first.invocation.id)?.executor, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual invocation 可指定 maxAttempts=1 首次失败即终态；failInvocation terminal 选项跳过重试", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const single = store.enqueueManualInvocation(created.id, NOW, { maxAttempts: 1 });
    assert.equal(single.maxAttempts, 1);
    const claim = store.claimPendingInvocation(single.id, "inline", NOW + 1);
    assert.ok(claim);
    assert.equal(
      store.failInvocation(single.id, claim.ownershipToken, "LLM 未配置", NOW + 2),
      INVOCATION_FAILURE_OUTCOMES.terminal,
    );
    assert.equal(store.getInvocation(single.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.active);
    const scheduled = store.claimDue({ workerId: "w1", nowMs: NOW + 20, limit: 1 })[0];
    assert.ok(scheduled);
    assert.equal(scheduled.invocation.mode, INVOCATION_MODES.scheduled);
    assert.equal(scheduled.invocation.maxAttempts, 3);
    assert.equal(
      store.failInvocation(
        scheduled.invocation.id,
        scheduled.ownershipToken,
        "权限边界已变化",
        NOW + 21,
        { terminal: true },
      ),
      INVOCATION_FAILURE_OUTCOMES.terminalPaused,
    );
    assert.equal(store.getInvocation(scheduled.invocation.id)?.attempt, 1);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.equal(store.getSchedule(created.id)?.lastError, "权限边界已变化");
    assert.equal(store.enqueueManualInvocation(created.id, NOW + 30).maxAttempts, 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneInvocations 按每任务保留数与保留时长删除终态行，不动 live 行", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, {
      retryBudget: 1,
      invocationRetentionPerSchedule: 2,
      invocationRetentionMs: 100_000,
    });
    const created = store.createSchedule(sampleInput(), NOW);
    const finishAt = (offset: number) => {
      const queued = store.enqueueManualInvocation(created.id, NOW + offset);
      const claim = store.claimPendingInvocation(queued.id, "w", NOW + offset);
      assert.ok(claim);
      store.completeInvocation({
        id: queued.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + offset,
      });
      return queued.id;
    };
    const old = finishAt(0);
    const a = finishAt(1_000);
    const b = finishAt(2_000);
    const c = finishAt(3_000);
    const live = store.enqueueManualInvocation(created.id, NOW + 4_000);
    assert.equal(store.pruneInvocations(NOW + 100_500), 2);
    const remaining = store.listInvocations(created.id).map((row) => row.id);
    assert.deepEqual(new Set(remaining), new Set([b, c, live.id]));
    assert.ok(!remaining.includes(old) && !remaining.includes(a));
    assert.equal(store.pruneInvocations(NOW + 100_500), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorityDigest 随 schedule 保存并可通过 setAuthorityDigest 更新", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ authorityDigest: "sha256:aaa" }), NOW);
    assert.equal(created.authorityDigest, "sha256:aaa");
    assert.equal(store.createSchedule(sampleInput(), NOW).authorityDigest, undefined);
    assert.equal(store.setAuthorityDigest(created.id, "sha256:bbb", NOW + 1), true);
    assert.equal(store.getSchedule(created.id)?.authorityDigest, "sha256:bbb");
    assert.equal(store.getSchedule(created.id)?.updatedAtMs, NOW + 1);
    assert.equal(store.setAuthorityDigest("missing", "x", NOW), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("打开 schema v1 数据库时自动补齐新列并升级 user_version", () => {
  const dir = tempDir();
  try {
    const legacy = new DatabaseSync(join(dir, "schedules.db"));
    legacy.exec(
      `CREATE TABLE schedules (
         id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
         trigger_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
         next_run_at INTEGER, last_run_at INTEGER, last_error TEXT,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE invocations (
         id TEXT PRIMARY KEY,
         schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
         mode TEXT NOT NULL, status TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
         attempt INTEGER NOT NULL DEFAULT 0, claimed_by TEXT, ownership_token TEXT,
         lease_until INTEGER, retry_at INTEGER, thread_id TEXT, output_excerpt TEXT, error TEXT,
         pending_actions_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
         started_at INTEGER, finished_at INTEGER, UNIQUE (schedule_id, mode, scheduled_for));
       INSERT INTO schedules VALUES ('s1', 'n', 'p', '/w', '{"kind":"interval","everyMs":60000}',
         'active', 1, NULL, NULL, 1, 1);
       INSERT INTO invocations (id, schedule_id, mode, status, scheduled_for, attempt, created_at)
         VALUES ('i1', 's1', 'manual', 'retry', 1, 1, 1);
       PRAGMA user_version = 1;`,
    );
    legacy.close();
    const store = new ScheduleStore(dir);
    assert.equal(store.getSchedule("s1")?.authorityDigest, undefined);
    const migrated = store.getInvocation("i1");
    assert.equal(migrated?.maxAttempts, 3);
    assert.equal(migrated?.executor, undefined);
    store.close();
    const reopened = new DatabaseSync(join(dir, "schedules.db"));
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, 2);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
