import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScheduleStore } from "./schedule-store.ts";

test("clock rollback before extension skips a previously consumed slot without spending quota", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-clock-rollback-"));
  const store = new ScheduleStore(dir);
  const now = Date.parse("2026-09-10T09:00:00Z");
  const interval = 60_000;
  try {
    const schedule = store.createSchedule(
      {
        name: "回拨巡检",
        prompt: "检查未读",
        cwd: dir,
        trigger: { kind: "interval", everyMs: interval },
        maxRounds: 1,
        fireImmediately: true,
      },
      now,
    );
    const first = store.claimDue({ workerId: "test", nowMs: now, limit: 1 })[0];
    assert.ok(first);
    assert.equal(
      store.completeInvocation({
        id: first.invocation.id,
        ownershipToken: first.ownershipToken,
        status: "completed",
        nowMs: now + 1,
      }),
      "written",
    );

    // The wall clock moves back before the user extends the completed task.
    // After one interval its next slot collides with the already completed run.
    const extension = store.extendSchedule(
      {
        scheduleId: schedule.id,
        expectedMaxRounds: 1,
        additionalRounds: 1,
        requestId: "clock-rollback-extension",
        authorityDigest: "reauthorized",
      },
      now - interval,
    );
    assert.equal(extension.schedule.nextRunAtMs, now);
    assert.deepEqual(store.claimDue({ workerId: "test", nowMs: now, limit: 1 }), []);
    assert.equal(store.getSchedule(schedule.id)?.roundsStarted, 1);
    assert.equal(store.getSchedule(schedule.id)?.nextRunAtMs, now + interval);
    assert.equal(store.nextWakeAtMs(), now + interval);
    assert.deepEqual(store.claimDue({ workerId: "test", nowMs: now, limit: 1 }), []);
    assert.equal(store.listInvocations(schedule.id).length, 1);

    const next = store.claimDue({ workerId: "test", nowMs: now + interval, limit: 1 })[0];
    assert.ok(next, "a fresh slot must resume the extended schedule");
    assert.notEqual(next.invocation.id, first.invocation.id);
    assert.equal(next.schedule.roundsStarted, 2);
    assert.equal(next.schedule.nextRunAtMs, undefined);
    assert.equal(
      store.completeInvocation({
        id: next.invocation.id,
        ownershipToken: next.ownershipToken,
        status: "completed",
        nowMs: now + interval + 1,
      }),
      "written",
    );
    assert.equal(store.getSchedule(schedule.id)?.status, "completed");
    assert.equal(store.listInvocations(schedule.id).length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
