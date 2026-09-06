import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduleStore, readScheduleHistory, readScheduleRun } from "./schedule-store.ts";
import { createIntervalTrigger } from "./trigger.ts";

const NOW = Date.parse("2026-09-05T09:00:00.000Z");

function fixture(options: ConstructorParameters<typeof ScheduleStore>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "roll-schedule-history-"));
  const store = new ScheduleStore(dir, options);
  const schedule = store.createSchedule(
    {
      name: "任务快照",
      prompt: "检查",
      cwd: "/original/workspace",
      trigger: createIntervalTrigger("30m"),
      fireImmediately: true,
    },
    NOW,
  );
  const claim = store.claimDue({ workerId: "test", nowMs: NOW, limit: 1 })[0];
  assert.ok(claim);
  return {
    dir,
    store,
    schedule,
    claim,
    input: {
      invocationId: claim.invocation.id,
      expectedAttempt: claim.invocation.attempt,
      ownershipToken: claim.ownershipToken,
      threadId: "thread-1",
      threadsDir: join(dir, "original-threads"),
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("reference registration is fenced by running state, token, attempt and immutable identity", () => {
  const f = fixture();
  try {
    assert.equal(f.store.registerThreadReference(f.input, NOW), undefined);
    f.store.beginInvocation(f.input.invocationId, f.input.ownershipToken, NOW);
    assert.equal(
      f.store.registerThreadReference({ ...f.input, ownershipToken: "wrong" }, NOW),
      undefined,
    );
    assert.equal(
      f.store.registerThreadReference({ ...f.input, expectedAttempt: 2 }, NOW),
      undefined,
    );
    assert.throws(() =>
      f.store.registerThreadReference({ ...f.input, threadsDir: "relative" }, NOW),
    );
    const before = f.store.getInvocation(f.input.invocationId);
    const ref = f.store.registerThreadReference(f.input, NOW);
    assert.deepEqual(ref, {
      invocationId: f.input.invocationId,
      attempt: 1,
      scheduleId: f.schedule.id,
      threadId: f.input.threadId,
      threadsDir: f.input.threadsDir,
      name: f.schedule.name,
      cwd: f.schedule.cwd,
      scheduledForMs: NOW,
      mode: "scheduled",
      createdAtMs: NOW,
    });
    assert.deepEqual(f.store.registerThreadReference(f.input, NOW + 99), ref);
    assert.deepEqual(f.store.getInvocation(f.input.invocationId), before);
    assert.throws(
      () => f.store.registerThreadReference({ ...f.input, threadId: "different" }),
      /已关联/u,
    );
    assert.throws(
      () => f.store.registerThreadReference({ ...f.input, threadsDir: "/different" }),
      /已关联/u,
    );
    assert.equal(existsSync(f.input.threadsDir), false);
    assert.equal(
      readScheduleRun(f.dir, f.input.invocationId).run?.references[0]?.threadId,
      "thread-1",
    );
    f.store.failInvocation(f.input.invocationId, f.input.ownershipToken, "cancelled", NOW + 1, {
      terminal: true,
    });
    assert.equal(f.store.registerThreadReference(f.input), undefined);
  } finally {
    f.close();
  }
});

test("retries retain separate attempt references through failure, retention and task removal", () => {
  const f = fixture({ retryBudget: 2, retryBackoffMs: 10, invocationRetentionMs: 1 });
  try {
    f.store.beginInvocation(f.input.invocationId, f.input.ownershipToken, NOW);
    f.store.registerThreadReference(f.input, NOW);
    f.store.failInvocation(f.input.invocationId, f.input.ownershipToken, "first failure", NOW + 1);
    const second = f.store.claimDue({ workerId: "test", nowMs: NOW + 100, limit: 1 })[0];
    assert.ok(second);
    f.store.beginInvocation(second.invocation.id, second.ownershipToken, NOW + 100);
    assert.equal(f.store.registerThreadReference(f.input), undefined);
    f.store.registerThreadReference(
      {
        ...f.input,
        expectedAttempt: 2,
        ownershipToken: second.ownershipToken,
        threadId: "thread-2",
        threadsDir: "/moved/threads",
      },
      NOW + 100,
    );
    let run = readScheduleRun(f.dir, f.input.invocationId).run;
    assert.deepEqual(
      run?.references.map((ref) => ref.attempt),
      [1, 2],
    );
    assert.equal(run?.invocation?.status, "running");
    f.store.completeInvocation({
      id: second.invocation.id,
      ownershipToken: second.ownershipToken,
      status: "completed",
      nowMs: NOW + 101,
      threadId: "thread-2",
      outputExcerpt: "done",
    });
    assert.equal(f.store.pruneInvocations(NOW + 200), 1);
    run = readScheduleRun(f.dir, f.input.invocationId).run;
    assert.equal(run?.invocation, undefined);
    assert.equal(run?.references.length, 2);
    assert.equal(f.store.removeSchedule(f.schedule.id), true);
    const history = readScheduleHistory(f.dir);
    assert.equal(history.tasks.length, 1);
    assert.equal(history.tasks[0]?.schedule, undefined);
    assert.equal(history.tasks[0]?.name, "任务快照");
    assert.equal(history.tasks[0]?.latestRun?.invocation, undefined);
    assert.equal(history.runs.length, 1);
    assert.deepEqual(
      history.runs[0]?.references.map((ref) => ref.threadsDir),
      [f.input.threadsDir, "/moved/threads"],
    );
  } finally {
    f.close();
  }
});

test("backfill only accepts the ledger-proven thread and attempt, preserving legacy timestamps", () => {
  const f = fixture();
  try {
    f.store.beginInvocation(f.input.invocationId, f.input.ownershipToken, NOW);
    f.store.completeInvocation({
      id: f.input.invocationId,
      ownershipToken: f.input.ownershipToken,
      status: "completed",
      threadId: "legacy-thread",
      nowMs: NOW + 1,
    });
    const before = f.store.getInvocation(f.input.invocationId);
    assert.equal(f.store.backfillThreadReference(f.input), undefined);
    assert.equal(
      f.store.backfillThreadReference({
        ...f.input,
        threadId: "legacy-thread",
        expectedAttempt: 2,
      }),
      undefined,
    );
    const input = { ...f.input, threadId: "legacy-thread" };
    const ref = f.store.backfillThreadReference(input, NOW + 2);
    assert.equal(ref?.threadId, "legacy-thread");
    assert.deepEqual(f.store.backfillThreadReference(input, NOW + 3), ref);
    assert.deepEqual(f.store.getInvocation(f.input.invocationId), before);
  } finally {
    f.close();
  }
});

test("history pagination counts runs once across retries and preserves all task identities", () => {
  const f = fixture();
  try {
    f.store.beginInvocation(f.input.invocationId, f.input.ownershipToken, NOW);
    f.store.registerThreadReference(f.input, NOW);
    f.store.completeInvocation({
      id: f.input.invocationId,
      ownershipToken: f.input.ownershipToken,
      status: "completed",
      nowMs: NOW + 1,
    });
    const ids = [f.input.invocationId];
    for (let n = 1; n <= 24; n++) {
      ids.push(f.store.enqueueManualInvocation(f.schedule.id, NOW + n * 100).id);
    }
    const first = readScheduleHistory(f.dir, { scheduleId: f.schedule.id });
    const next = readScheduleHistory(f.dir, { scheduleId: f.schedule.id, offset: 20 });
    assert.equal(first.runs.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(next.runs.length, 5);
    assert.equal(next.hasMore, false);
    assert.deepEqual(
      [...first.runs, ...next.runs].map((run) => run.invocationId),
      ids.reverse(),
    );
    assert.equal(first.tasks.length, 1);
    assert.equal(readScheduleHistory(f.dir, { scheduleId: "not-found" }).runs.length, 0);
    assert.equal(readScheduleHistory(f.dir, { scheduleId: "not-found" }).tasks.length, 1);
    assert.throws(() => readScheduleHistory(f.dir, { offset: -1 }), RangeError);
  } finally {
    f.close();
  }
});

test("readers never create, chmod, migrate or write scheduler storage and can read schema v5", () => {
  const f = fixture();
  try {
    const missing = join(f.dir, "does-not-exist");
    assert.equal(readScheduleHistory(missing).status, "empty");
    assert.equal(readScheduleRun(missing, "missing").status, "empty");
    assert.equal(existsSync(missing), false);
    const path = join(f.dir, "schedules.db");
    if (process.platform !== "win32") {
      chmodSync(f.dir, 0o755);
      chmodSync(path, 0o644);
    }
    const before = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    readScheduleHistory(f.dir);
    readScheduleRun(f.dir, f.input.invocationId);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).mtimeMs, mtime);
    if (process.platform !== "win32") {
      assert.equal(statSync(f.dir).mode & 0o777, 0o755);
      assert.equal(statSync(path).mode & 0o777, 0o644);
    }
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE schedule_thread_refs; PRAGMA user_version = 5;");
    raw.close();
    const legacy = readScheduleHistory(f.dir);
    assert.equal(legacy.status, "ok");
    assert.equal(legacy.runs[0]?.references.length, 0);
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 5);
    check.close();
    const bump = new DatabaseSync(path);
    bump.exec("PRAGMA user_version = 999");
    bump.close();
    assert.equal(readScheduleRun(f.dir, f.input.invocationId).status, "migration-required");
    assert.equal(readScheduleHistory(f.dir).schemaVersion, 999);
  } finally {
    f.close();
  }
});
