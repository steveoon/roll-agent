import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
