import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntervalTrigger } from "./trigger.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { SCHEDULER_LIMITS } from "./limits.ts";

const NOW = Date.parse("2026-08-26T09:00:00.000Z");

function seedExpiredRunning(store: ScheduleStore, name: string): string {
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
    pid: 4242,
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
    const round2 = store.claimDue({
      workerId: "new-daemon",
      nowMs: expiredAt + SCHEDULER_LIMITS.claimLeaseMs + 1,
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
