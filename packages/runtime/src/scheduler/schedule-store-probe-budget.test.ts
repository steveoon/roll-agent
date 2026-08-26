import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntervalTrigger } from "./trigger.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { SCHEDULER_LIMITS } from "./limits.ts";

const NOW = Date.parse("2026-08-26T09:00:00.000Z");

function seedExpiredRunning(store: ScheduleStore, name: string, pid: number = 4242): string {
  const schedule = store.createSchedule(
    {
      name,
      prompt: "p",
      cwd: "/workspace",
      trigger: createIntervalTrigger("30m"),
      fireImmediately: false,
    },
    NOW,
  );
  const queued = store.enqueueManualInvocation(schedule.id, NOW);
  const claim = store.claimPendingInvocation(queued.id, "old-daemon", NOW);
  assert.ok(claim);
  store.beginInvocation(queued.id, claim.ownershipToken, NOW, {
    pid,
    startToken: "pst-v2:root",
  });
  return queued.id;
}

test("claimDue 每个事务最多探活 maxLivenessProbesPerClaim 个过期 running 行，其余续租等下一轮", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    let probes = 0;
    const store = new ScheduleStore(dir, {
      executorLiveness: () => {
        probes += 1;
        return "dead";
      },
    });
    assert.equal(SCHEDULER_LIMITS.maxLivenessProbesPerClaim, 1);
    const first = seedExpiredRunning(store, "a");
    const second = seedExpiredRunning(store, "b");
    const expiredAt = NOW + SCHEDULER_LIMITS.claimLeaseMs + 1;
    const round1 = store.claimDue({ workerId: "new-daemon", nowMs: expiredAt, limit: 5 });
    assert.equal(probes, 1);
    assert.deepEqual(
      round1.map((claim) => claim.invocation.id),
      [first],
    );
    assert.equal(store.getInvocation(second)?.status, "running");
    assert.deepEqual(
      store.claimDue({
        workerId: "new-daemon",
        nowMs: expiredAt + SCHEDULER_LIMITS.livenessProbeDeferralMs - 1,
        limit: 5,
        heldInvocationIds: new Set([first]),
      }),
      [],
    );
    assert.equal(probes, 1);
    const round2 = store.claimDue({
      workerId: "new-daemon",
      nowMs: expiredAt + SCHEDULER_LIMITS.livenessProbeDeferralMs + 1,
      limit: 5,
      heldInvocationIds: new Set([first]),
    });
    assert.equal(probes, 2);
    assert.deepEqual(
      round2.map((claim) => claim.invocation.id),
      [second],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxLivenessProbesPerClaim 放宽后一个事务可以回收多行", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    let probes = 0;
    const store = new ScheduleStore(dir, {
      executorLiveness: () => {
        probes += 1;
        return "dead";
      },
      maxLivenessProbesPerClaim: 2,
    });
    seedExpiredRunning(store, "a");
    seedExpiredRunning(store, "b");
    const round = store.claimDue({
      workerId: "new-daemon",
      nowMs: NOW + SCHEDULER_LIMITS.claimLeaseMs + 1,
      limit: 5,
    });
    assert.equal(probes, 2);
    assert.equal(round.length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("排在前面的 alive 孤儿不会让后面的 dead 行永远得不到探活（最久未探活优先）", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    const probedPids: number[] = [];
    const store = new ScheduleStore(dir, {
      executorLiveness: (executor) => {
        probedPids.push(executor.pid);
        return executor.pid === 1111 ? "alive" : "dead";
      },
    });
    seedExpiredRunning(store, "alive-first", 1111);
    const dead = seedExpiredRunning(store, "dead-second", 2222);
    const expiredAt = NOW + SCHEDULER_LIMITS.claimLeaseMs + 1;
    const tick = SCHEDULER_LIMITS.livenessProbeDeferralMs;
    let reclaimedAtTick: number | undefined;
    for (let round = 0; round < 6 && reclaimedAtTick === undefined; round += 1) {
      const claims = store.claimDue({
        workerId: "new-daemon",
        nowMs: expiredAt + round * tick + (round === 0 ? 0 : 1),
        limit: 5,
      });
      if (claims.some((claim) => claim.invocation.id === dead)) {
        reclaimedAtTick = round;
      }
    }
    assert.equal(reclaimedAtTick, 1);
    assert.deepEqual(probedPids, [1111, 2222]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多个 alive 孤儿错开到期时，dead 行仍在有限轮内被回收", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    const probesPerTick: number[] = [];
    let probesThisTick = 0;
    const store = new ScheduleStore(dir, {
      executorLiveness: (executor) => {
        probesThisTick += 1;
        return executor.pid === 9999 ? "dead" : "alive";
      },
    });
    seedExpiredRunning(store, "a1", 1);
    seedExpiredRunning(store, "a2", 2);
    seedExpiredRunning(store, "a3", 3);
    const dead = seedExpiredRunning(store, "dead", 9999);
    const expiredAt = NOW + SCHEDULER_LIMITS.claimLeaseMs + 1;
    const tick = SCHEDULER_LIMITS.livenessProbeDeferralMs;
    let reclaimedAtTick: number | undefined;
    for (let round = 0; round < 40 && reclaimedAtTick === undefined; round += 1) {
      probesThisTick = 0;
      const claims = store.claimDue({
        workerId: "new-daemon",
        nowMs: expiredAt + round * tick + (round === 0 ? 0 : 1),
        limit: 5,
      });
      probesPerTick.push(probesThisTick);
      if (claims.some((claim) => claim.invocation.id === dead)) {
        reclaimedAtTick = round;
      }
    }
    assert.ok(reclaimedAtTick !== undefined && reclaimedAtTick <= 3, String(reclaimedAtTick));
    assert.ok(probesPerTick.every((count) => count <= 1));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alive 孤儿数达到 claimLeaseMs / livenessProbeDeferralMs 时，最久未探活轮换仍保证 dead 行被回收", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    const parked = Math.ceil(
      SCHEDULER_LIMITS.claimLeaseMs / SCHEDULER_LIMITS.livenessProbeDeferralMs,
    );
    const store = new ScheduleStore(dir, {
      executorLiveness: (executor) => (executor.pid === 9999 ? "dead" : "alive"),
    });
    for (let index = 0; index < parked; index += 1) {
      seedExpiredRunning(store, `alive${String(index)}`, 100 + index);
    }
    const dead = seedExpiredRunning(store, "dead-last", 9999);
    const expiredAt = NOW + SCHEDULER_LIMITS.claimLeaseMs + 1;
    const tick = SCHEDULER_LIMITS.livenessProbeDeferralMs;
    let reclaimedAtTick: number | undefined;
    for (let round = 0; round < parked * 4 && reclaimedAtTick === undefined; round += 1) {
      const claims = store.claimDue({
        workerId: "new-daemon",
        nowMs: expiredAt + round * tick + (round === 0 ? 0 : 1),
        limit: 5,
      });
      if (claims.some((claim) => claim.invocation.id === dead)) {
        reclaimedAtTick = round;
      }
    }
    assert.equal(reclaimedAtTick, parked);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("轮换状态持久化在账本里：换一个 ScheduleStore 实例（daemon 重启）后 dead 行仍优先于刚探过的 alive 行", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    const probedPids: number[] = [];
    const options = {
      claimLeaseMs: 20_000,
      executorLiveness: (executor: { readonly pid: number }) => {
        probedPids.push(executor.pid);
        return executor.pid === 1111 ? ("alive" as const) : ("dead" as const);
      },
    };
    const first = new ScheduleStore(dir, options);
    seedExpiredRunning(first, "alive-first", 1111);
    const dead = seedExpiredRunning(first, "dead-second", 2222);
    const expiredAt = NOW + options.claimLeaseMs + 1;
    assert.deepEqual(first.claimDue({ workerId: "old-daemon", nowMs: expiredAt, limit: 5 }), []);
    assert.deepEqual(probedPids, [1111]);
    first.close();
    const second = new ScheduleStore(dir, options);
    const claims = second.claimDue({
      workerId: "new-daemon",
      nowMs: expiredAt + options.claimLeaseMs + 1,
      limit: 5,
    });
    assert.deepEqual(probedPids, [1111, 2222]);
    assert.deepEqual(
      claims.map((claim) => claim.invocation.id),
      [dead],
    );
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("已是 v2 的旧账本（无 executor_probed_at 列）打开时会补列，claimDue 的探活轮转照常工作", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    const seeded = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    const dead = seedExpiredRunning(seeded, "legacy", 2222);
    seeded.close();
    const raw = new DatabaseSync(join(dir, "schedules.db"));
    raw.exec("ALTER TABLE invocations DROP COLUMN executor_probed_at; PRAGMA user_version = 2;");
    raw.close();
    const reopened = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    const inspect = new DatabaseSync(join(dir, "schedules.db"));
    const columns = (
      inspect.prepare("PRAGMA table_info(invocations)").all() as Array<{ readonly name: string }>
    ).map((column) => column.name);
    const version = inspect.prepare("PRAGMA user_version").get() as { user_version: number };
    inspect.close();
    assert.ok(columns.includes("executor_probed_at"));
    assert.equal(version.user_version, 3);
    const claims = reopened.claimDue({
      workerId: "new-daemon",
      nowMs: NOW + SCHEDULER_LIMITS.claimLeaseMs + 1,
      limit: 5,
    });
    assert.deepEqual(
      claims.map((claim) => claim.invocation.id),
      [dead],
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon 满载（limit ≤ 0）时不花探活名额，也不改变轮转顺序", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    let probes = 0;
    const store = new ScheduleStore(dir, {
      executorLiveness: () => {
        probes += 1;
        return "dead";
      },
    });
    const dead = seedExpiredRunning(store, "dead", 9999);
    const expiredAt = NOW + SCHEDULER_LIMITS.claimLeaseMs + 1;
    assert.deepEqual(store.claimDue({ workerId: "busy", nowMs: expiredAt, limit: 0 }), []);
    assert.equal(probes, 0);
    const inspect = new DatabaseSync(join(dir, "schedules.db"));
    const row = inspect
      .prepare("SELECT executor_probed_at, lease_until FROM invocations WHERE id = ?")
      .get(dead) as { executor_probed_at: number | null; lease_until: number };
    inspect.close();
    assert.equal(row.executor_probed_at, null);
    assert.equal(row.lease_until, expiredAt + SCHEDULER_LIMITS.livenessProbeDeferralMs);
    const claims = store.claimDue({
      workerId: "free",
      nowMs: expiredAt + SCHEDULER_LIMITS.livenessProbeDeferralMs + 1,
      limit: 5,
    });
    assert.equal(probes, 1);
    assert.deepEqual(
      claims.map((claim) => claim.invocation.id),
      [dead],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beginInvocation 写入新 executor 时清零 executor_probed_at，重新崩溃的行不会排在轮转队尾", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-probe-budget-"));
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    const dead = seedExpiredRunning(store, "crash-twice", 2222);
    const expiredAt = NOW + SCHEDULER_LIMITS.claimLeaseMs + 1;
    const reclaimed = store.claimDue({ workerId: "d", nowMs: expiredAt, limit: 5 });
    assert.deepEqual(
      reclaimed.map((claim) => claim.invocation.id),
      [dead],
    );
    const read = () => {
      const inspect = new DatabaseSync(join(dir, "schedules.db"));
      const row = inspect
        .prepare("SELECT executor_probed_at FROM invocations WHERE id = ?")
        .get(dead) as { executor_probed_at: number | null };
      inspect.close();
      return row.executor_probed_at;
    };
    assert.equal(read(), expiredAt);
    const claim = reclaimed[0];
    assert.ok(claim);
    store.beginInvocation(dead, claim.ownershipToken, expiredAt, {
      pid: 3333,
      startToken: "pst-v2:again",
    });
    assert.equal(read(), null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
