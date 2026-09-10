import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduleStore, readScheduleHistory, readScheduleLedger } from "./schedule-store.ts";
import { createIntervalTrigger } from "./trigger.ts";

const NOW = Date.parse("2026-09-10T09:00:00.000Z");
const INTERVAL = 60_000;

function fixture(options: ConstructorParameters<typeof ScheduleStore>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "roll-extend-"));
  const store = new ScheduleStore(dir, options);
  return {
    dir,
    store,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function create(store: ScheduleStore, maxRounds: number | null = 1) {
  return store.createSchedule(
    {
      name: "有限巡检扩容",
      prompt: "检查未读消息",
      cwd: "/workspace/extension",
      trigger: createIntervalTrigger("1m"),
      authorityDigest: "original-authority",
      fireImmediately: true,
      ...(maxRounds === null ? {} : { maxRounds }),
    },
    NOW,
  );
}

function finishNext(store: ScheduleStore, nowMs: number) {
  const current = store.claimDue({ workerId: "extension-test", nowMs, limit: 1 })[0];
  assert.ok(current);
  assert.equal(
    store.completeInvocation({
      id: current.invocation.id,
      ownershipToken: current.ownershipToken,
      status: "completed",
      nowMs: nowMs + 1,
      threadId: `thread-${current.invocation.id}`,
    }),
    "written",
  );
  return current.invocation.id;
}

function exhausted(store: ScheduleStore, maxRounds = 1) {
  const schedule = create(store, maxRounds);
  for (let round = 0; round < maxRounds; round += 1) finishNext(store, NOW + round * INTERVAL);
  assert.equal(store.getSchedule(schedule.id)?.status, "completed");
  return schedule.id;
}

function request(
  scheduleId: string,
  overrides: Partial<Parameters<ScheduleStore["extendSchedule"]>[0]> = {},
) {
  return {
    scheduleId,
    additionalRounds: 2,
    expectedMaxRounds: 1,
    requestId: "extend-request-1",
    authorityDigest: "extension-authority",
    ...overrides,
  };
}

test("schedule extension: completed 20 rounds plus 30 retains identity and history and stops at 50", () => {
  const f = fixture();
  try {
    const id = exhausted(f.store, 20);
    const history = f.store.listInvocations(id).map((run) => run.id);
    const extensionAt = NOW + 30 * INTERVAL;
    const result = f.store.extendSchedule(
      request(id, { additionalRounds: 30, expectedMaxRounds: 20 }),
      extensionAt,
    );
    assert.equal(result.extended, true);
    assert.equal(result.schedule.id, id);
    assert.equal(result.schedule.roundsStarted, 20);
    assert.equal(result.schedule.maxRounds, 50);
    assert.equal(result.schedule.authorityDigest, "extension-authority");
    assert.equal(result.schedule.status, "active");
    assert.equal(result.schedule.nextRunAtMs, extensionAt + INTERVAL);
    assert.deepEqual(
      f.store.listInvocations(id).map((run) => run.id),
      history,
    );
    assert.deepEqual(
      f.store.claimDue({ workerId: "early", nowMs: extensionAt + INTERVAL - 1, limit: 10 }),
      [],
    );
    for (let round = 1; round <= 30; round += 1) {
      finishNext(f.store, extensionAt + round * INTERVAL);
    }
    assert.equal(f.store.getSchedule(id)?.status, "completed");
    assert.equal(f.store.getSchedule(id)?.roundsStarted, 50);
    assert.equal(f.store.getSchedule(id)?.maxRounds, 50);
    assert.equal(f.store.getSchedule(id)?.nextRunAtMs, undefined);
    assert.equal(f.store.listInvocations(id, 100).length, 50);
    assert.deepEqual(
      f.store.claimDue({ workerId: "later", nowMs: extensionAt + 100 * INTERVAL, limit: 10 }),
      [],
    );
  } finally {
    f.cleanup();
  }
});

test("schedule extension: exact request replay on another connection never doubles quota or reauthorizes", () => {
  const f = fixture();
  const other = new ScheduleStore(f.dir);
  try {
    const id = exhausted(f.store);
    const input = request(id);
    assert.equal(f.store.getScheduleExtension(input.requestId), undefined);
    const first = f.store.extendSchedule(input, NOW + 2);
    const receipt = f.store.getScheduleExtension(input.requestId);
    assert.deepEqual(receipt, {
      requestId: input.requestId,
      scheduleId: id,
      expectedMaxRounds: 1,
      additionalRounds: 2,
      authorityDigest: "extension-authority",
      createdAtMs: NOW + 2,
    });
    const replay = other.extendSchedule(
      { ...input, authorityDigest: "changed-after-confirmation" },
      NOW + 100,
    );
    assert.equal(first.extended, true);
    assert.equal(replay.extended, false);
    assert.deepEqual(replay.schedule, first.schedule);
    assert.equal(replay.schedule.authorityDigest, "extension-authority");
    assert.deepEqual(other.getScheduleExtension(input.requestId), receipt);
    assert.throws(() =>
      other.extendSchedule(request(id, { requestId: "competing-request" }), NOW + 101),
    );
    assert.equal(f.store.getSchedule(id)?.maxRounds, 3);
  } finally {
    other.close();
    f.cleanup();
  }
});

test("schedule extension: receipts survive later extension, restart and pruning without replaying old effects", () => {
  const f = fixture({ invocationRetentionPerSchedule: 1, invocationRetentionMs: 1 });
  let reopened: ScheduleStore | undefined;
  let closed = false;
  try {
    const id = exhausted(f.store);
    const first = request(id);
    f.store.extendSchedule(first, NOW + 2);
    finishNext(f.store, NOW + 2 + INTERVAL);
    finishNext(f.store, NOW + 2 + 2 * INTERVAL);
    const laterAt = NOW + 3 * INTERVAL;
    const latest = f.store.extendSchedule(
      request(id, {
        requestId: "extend-request-2",
        expectedMaxRounds: 3,
        additionalRounds: 1,
        authorityDigest: "latest-authority",
      }),
      laterAt,
    );
    assert.equal(latest.schedule.maxRounds, 4);
    f.store.pruneInvocations(laterAt + 100);
    assert.equal(f.store.listInvocations(id).length, 0);
    f.store.close();
    closed = true;
    reopened = new ScheduleStore(f.dir);
    assert.equal(
      reopened.getScheduleExtension(first.requestId)?.authorityDigest,
      "extension-authority",
    );
    const replay = reopened.extendSchedule(first, laterAt + 101);
    assert.equal(replay.extended, false);
    assert.equal(replay.schedule.maxRounds, 4);
    assert.equal(replay.schedule.roundsStarted, 3);
    assert.equal(replay.schedule.authorityDigest, "latest-authority");
    assert.equal(replay.schedule.nextRunAtMs, laterAt + INTERVAL);
  } finally {
    reopened?.close();
    if (closed) rmSync(f.dir, { recursive: true, force: true });
    else f.cleanup();
  }
});

test("schedule extension: reusing a request ID for a different payload or task is rejected", () => {
  const f = fixture();
  try {
    const id = exhausted(f.store);
    const otherId = exhausted(f.store);
    const first = f.store.extendSchedule(request(id), NOW + 2);
    for (const changed of [
      request(id, { additionalRounds: 3 }),
      request(id, { expectedMaxRounds: 2 }),
      request(otherId),
    ]) {
      assert.throws(() => f.store.extendSchedule(changed, NOW + 3));
    }
    assert.deepEqual(f.store.getSchedule(id), first.schedule);
    assert.equal(f.store.getSchedule(otherId)?.maxRounds, 1);
  } finally {
    f.cleanup();
  }
});

test("schedule extension: rejects invalid counts, stale base and request IDs without changing schedule", () => {
  const f = fixture();
  try {
    const id = exhausted(f.store);
    const before = f.store.getSchedule(id);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => f.store.extendSchedule(request(id, { additionalRounds: bad }), NOW + 2));
      assert.throws(() => f.store.extendSchedule(request(id, { expectedMaxRounds: bad }), NOW + 2));
    }
    for (const requestId of ["", "x".repeat(129)]) {
      assert.throws(() => f.store.extendSchedule(request(id, { requestId }), NOW + 2));
    }
    assert.throws(() => f.store.extendSchedule(request(id, { expectedMaxRounds: 2 }), NOW + 2));
    assert.deepEqual(f.store.getSchedule(id), before);
    assert.equal(
      f.store.extendSchedule(request(id, { requestId: "x".repeat(128) }), NOW + 2).extended,
      true,
    );
  } finally {
    f.cleanup();
  }
});

test("schedule extension: sum overflow is rejected even when both operands are safe integers", () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.dir, "schedules.db"));
  try {
    const schedule = create(f.store, Number.MAX_SAFE_INTEGER);
    db.prepare(
      "UPDATE schedules SET rounds_started = ?, status = 'completed', next_run_at = NULL WHERE id = ?",
    ).run(Number.MAX_SAFE_INTEGER, schedule.id);
    const before = f.store.getSchedule(schedule.id);
    assert.throws(() =>
      f.store.extendSchedule(
        request(schedule.id, { additionalRounds: 1, expectedMaxRounds: Number.MAX_SAFE_INTEGER }),
        NOW + 2,
      ),
    );
    assert.deepEqual(f.store.getSchedule(schedule.id), before);
  } finally {
    db.close();
    f.cleanup();
  }
});

test("schedule extension: active, paused, unlimited, missing and inconsistent completed tasks cannot extend", () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.dir, "schedules.db"));
  try {
    const active = create(f.store);
    assert.throws(() => f.store.extendSchedule(request(active.id), NOW + 1));
    f.store.setScheduleStatus(active.id, "paused", NOW + 2);
    assert.throws(() => f.store.extendSchedule(request(active.id), NOW + 3));
    const unlimited = create(f.store, null);
    assert.equal(unlimited.maxRounds, undefined);
    assert.throws(() => f.store.extendSchedule(request(unlimited.id), NOW + 3));
    assert.throws(() => f.store.extendSchedule(request("missing"), NOW + 3));
    db.prepare("UPDATE schedules SET status = 'completed', next_run_at = NULL WHERE id = ?").run(
      active.id,
    );
    assert.throws(() => f.store.extendSchedule(request(active.id), NOW + 4));
    assert.equal(f.store.getSchedule(active.id)?.maxRounds, 1);
    assert.equal(f.store.getSchedule(active.id)?.roundsStarted, 0);
  } finally {
    db.close();
    f.cleanup();
  }
});

for (const state of ["pending", "claimed", "running", "retry", "terminal-tree"] as const) {
  test(`schedule extension: newer manual ${state} invocation blocks extension`, () => {
    const f = fixture({ retryBudget: 3 });
    const db = new DatabaseSync(join(f.dir, "schedules.db"));
    try {
      const id = exhausted(f.store);
      const manual = f.store.enqueueManualInvocation(id, NOW + 2);
      if (state !== "pending") {
        const claimed = f.store.claimPendingInvocation(manual.id, "manual", NOW + 2);
        assert.ok(claimed);
        if (state === "running" || state === "retry") {
          assert.ok(f.store.beginInvocation(manual.id, claimed.ownershipToken, NOW + 3));
        }
        if (state === "retry") {
          assert.equal(
            f.store.failInvocation(manual.id, claimed.ownershipToken, "retry", NOW + 4),
            "retry-scheduled",
          );
        }
        if (state === "terminal-tree") {
          assert.equal(
            f.store.completeInvocation({
              id: manual.id,
              ownershipToken: claimed.ownershipToken,
              status: "completed",
              nowMs: NOW + 4,
            }),
            "written",
          );
          db.prepare(
            "UPDATE invocations SET tree_unsettled = 1, tree_tracked_pgids = '[4242]' WHERE id = ?",
          ).run(manual.id);
        }
      }
      const before = f.store.getSchedule(id);
      assert.throws(() => f.store.extendSchedule(request(id), NOW + 5));
      assert.deepEqual(f.store.getSchedule(id), before);
    } finally {
      db.close();
      f.cleanup();
    }
  });
}

test("schedule extension: receipt insertion failure rolls back quota, authority and next trigger", () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.dir, "schedules.db"));
  try {
    const id = exhausted(f.store);
    const before = f.store.getSchedule(id);
    db.exec(
      "CREATE TRIGGER reject_extension BEFORE INSERT ON schedule_extensions BEGIN SELECT RAISE(ABORT, 'extension injection'); END",
    );
    assert.throws(() => f.store.extendSchedule(request(id), NOW + 2), /extension injection/u);
    assert.deepEqual(f.store.getSchedule(id), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_extensions").get()?.count, 0);
    db.exec("DROP TRIGGER reject_extension");
    assert.equal(f.store.extendSchedule(request(id), NOW + 3).extended, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_extensions").get()?.count, 1);
  } finally {
    db.close();
    f.cleanup();
  }
});

test("schedule extension: quota update failure removes the earlier receipt in the same transaction", () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.dir, "schedules.db"));
  try {
    const id = exhausted(f.store);
    const before = f.store.getSchedule(id);
    db.exec(
      "CREATE TRIGGER reject_quota BEFORE UPDATE OF max_rounds ON schedules BEGIN SELECT RAISE(ABORT, 'quota injection'); END",
    );
    assert.throws(() => f.store.extendSchedule(request(id), NOW + 2), /quota injection/u);
    assert.equal(f.store.getScheduleExtension("extend-request-1"), undefined);
    assert.deepEqual(f.store.getSchedule(id), before);
    db.exec("DROP TRIGGER reject_quota");
    assert.equal(f.store.extendSchedule(request(id), NOW + 3).extended, true);
    assert.equal(f.store.getScheduleExtension("extend-request-1")?.createdAtMs, NOW + 3);
  } finally {
    db.close();
    f.cleanup();
  }
});

test("schedule extension: removing task cascades its receipt but retains other task receipts", () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.dir, "schedules.db"));
  try {
    const first = exhausted(f.store);
    const second = exhausted(f.store);
    f.store.extendSchedule(request(first), NOW + 2);
    f.store.extendSchedule(request(second, { requestId: "other-request" }), NOW + 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_extensions").get()?.count, 2);
    assert.equal(f.store.removeSchedule(first), true);
    assert.equal(f.store.getScheduleExtension("extend-request-1"), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_extensions").get()?.count, 1);
    assert.equal(
      f.store.extendSchedule(request(second, { requestId: "other-request" }), NOW + 3).extended,
      false,
    );
  } finally {
    db.close();
    f.cleanup();
  }
});

test("schedule extension: upgrading populated v7 to v8 preserves finite quota, state, runs and readonly compatibility", () => {
  const f = fixture();
  let closed = false;
  let upgraded: ScheduleStore | undefined;
  try {
    const id = exhausted(f.store, 2);
    const before = f.store.getSchedule(id);
    const runsBefore = f.store.listInvocations(id);
    f.store.close();
    closed = true;
    const old = new DatabaseSync(join(f.dir, "schedules.db"));
    old.exec("DROP TABLE IF EXISTS schedule_extensions; PRAGMA user_version = 7;");
    old.close();
    const bytes = readFileSync(join(f.dir, "schedules.db"));
    assert.deepEqual(readScheduleLedger(f.dir).schedules[0], before);
    assert.equal(readScheduleHistory(f.dir, { scheduleId: id }).status, "ok");
    assert.deepEqual(readFileSync(join(f.dir, "schedules.db")), bytes);
    upgraded = new ScheduleStore(f.dir);
    assert.deepEqual(upgraded.getSchedule(id), before);
    assert.deepEqual(upgraded.listInvocations(id), runsBefore);
    assert.equal(readScheduleLedger(f.dir).status, "ok");
    const check = new DatabaseSync(join(f.dir, "schedules.db"), { readOnly: true });
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 8);
    assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
    check.close();
    assert.equal(
      upgraded.extendSchedule(request(id, { expectedMaxRounds: 2 }), NOW + 10 * INTERVAL).schedule
        .maxRounds,
      4,
    );
  } finally {
    upgraded?.close();
    if (closed) rmSync(f.dir, { recursive: true, force: true });
    else f.cleanup();
  }
});
