import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduleStore, readScheduleHistory, readScheduleLedger } from "./schedule-store.ts";
import { createIntervalTrigger } from "./trigger.ts";
import type { ClaimedInvocation } from "./types.ts";

const NOW = Date.parse("2026-09-10T09:00:00.000Z");
const INTERVAL = 60_000;

function input(overrides: Partial<Parameters<ScheduleStore["createSchedule"]>[0]> = {}) {
  return {
    name: "有限巡检",
    prompt: "检查未读消息",
    cwd: "/workspace/finite-rounds",
    trigger: createIntervalTrigger("1m"),
    fireImmediately: true,
    maxRounds: 1,
    ...overrides,
  };
}

function fixture(options: ConstructorParameters<typeof ScheduleStore>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "roll-rounds-"));
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

function claim(store: ScheduleStore, nowMs = NOW) {
  const claimed = store.claimDue({ workerId: "rounds-test", nowMs, limit: 1 })[0];
  assert.ok(claimed, "expected an automatic claim or retry");
  return claimed;
}

function complete(store: ScheduleStore, claimed: ClaimedInvocation, nowMs: number) {
  assert.equal(
    store.completeInvocation({
      id: claimed.invocation.id,
      ownershipToken: claimed.ownershipToken,
      status: "completed",
      nowMs,
    }),
    "written",
  );
}

for (const rounds of [1, 20]) {
  test(`finite rounds: ${String(rounds)} automatic claims exhaust once, including competing connections`, () => {
    const f = fixture();
    const competitor = new ScheduleStore(f.dir);
    try {
      const schedule = f.store.createSchedule(input({ maxRounds: rounds }), NOW);
      assert.equal(schedule.roundsStarted, 0);
      const ids = new Set<string>();
      for (let index = 0; index < rounds; index += 1) {
        const nowMs = NOW + index * INTERVAL;
        const selected = index % 2 === 0 ? f.store : competitor;
        const other = selected === f.store ? competitor : f.store;
        const current = claim(selected, nowMs);
        ids.add(current.invocation.id);
        assert.equal(selected.getSchedule(schedule.id)?.roundsStarted, index + 1);
        assert.equal(selected.getSchedule(schedule.id)?.status, "active");
        assert.deepEqual(other.claimDue({ workerId: "competitor", nowMs, limit: 20 }), []);
        if (index === rounds - 1) {
          assert.equal(selected.getSchedule(schedule.id)?.nextRunAtMs, undefined);
        }
        complete(selected, current, nowMs + 1);
      }
      assert.equal(ids.size, rounds);
      assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
      assert.deepEqual(
        competitor.claimDue({ workerId: "later", nowMs: NOW + 100 * INTERVAL, limit: 20 }),
        [],
      );
      f.store.setScheduleStatus(schedule.id, "paused", NOW + 101 * INTERVAL);
      assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
      assert.throws(() => f.store.resumeSchedule(schedule.id, "digest", NOW + 102 * INTERVAL));
      assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, rounds);
    } finally {
      competitor.close();
      f.cleanup();
    }
  });
}

test("finite rounds: invalid limits are rejected by both creation methods without inserting rows", () => {
  const f = fixture();
  try {
    for (const maxRounds of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => f.store.createSchedule(input({ maxRounds }), NOW));
      assert.throws(() => f.store.createScheduleIdempotent(input({ maxRounds }), NOW));
    }
    assert.equal(f.store.listSchedules().length, 0);
    assert.equal(
      f.store.createSchedule(input({ maxRounds: Number.MAX_SAFE_INTEGER }), NOW).maxRounds,
      Number.MAX_SAFE_INTEGER,
    );
  } finally {
    f.cleanup();
  }
});

test("finite rounds: retry attempts share one round and final failure ends the exhausted schedule", () => {
  const f = fixture({ retryBudget: 3, retryBackoffMs: 10 });
  try {
    const schedule = f.store.createSchedule(input(), NOW);
    const first = claim(f.store);
    let current = first;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal(current.invocation.id, first.invocation.id);
      assert.equal(current.invocation.attempt, attempt);
      assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
      f.store.failInvocation(
        current.invocation.id,
        current.ownershipToken,
        `failure ${String(attempt)}`,
        NOW + attempt * 100,
      );
      if (attempt < 3) {
        assert.equal(f.store.getSchedule(schedule.id)?.status, "active");
        current = claim(f.store, NOW + attempt * 100 + 50);
      }
    }
    assert.equal(f.store.getInvocation(first.invocation.id)?.status, "failed");
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    assert.match(f.store.getSchedule(schedule.id)?.lastError ?? "", /failure 3/u);
    assert.deepEqual(
      f.store.claimDue({ workerId: "later", nowMs: NOW + 10 * INTERVAL, limit: 20 }),
      [],
    );
  } finally {
    f.cleanup();
  }
});

test("finite rounds: failure before exhaustion still pauses and resume preserves the consumed round", () => {
  const f = fixture({ retryBudget: 1 });
  try {
    const schedule = f.store.createSchedule(input({ maxRounds: 2 }), NOW);
    const first = claim(f.store);
    f.store.failInvocation(first.invocation.id, first.ownershipToken, "failed", NOW + 1);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "paused");
    f.store.resumeSchedule(schedule.id, "digest", NOW + 2);
    const last = claim(f.store, NOW + INTERVAL);
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 2);
    complete(f.store, last, NOW + INTERVAL + 1);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
  } finally {
    f.cleanup();
  }
});

test("finite rounds: cancellation and needs-confirmation consume their round and finish the plan", () => {
  for (const outcome of ["cancel", "needs_confirmation"] as const) {
    const f = fixture();
    try {
      const schedule = f.store.createSchedule(input(), NOW);
      const current = claim(f.store);
      if (outcome === "cancel") {
        assert.equal(
          f.store.cancelInvocation(current.invocation.id, "operator cancelled", NOW + 1),
          "cancelled",
        );
      } else {
        assert.equal(
          f.store.completeInvocation({
            id: current.invocation.id,
            ownershipToken: current.ownershipToken,
            status: outcome,
            pendingActions: ["browser.click"],
            nowMs: NOW + 1,
          }),
          "written",
        );
      }
      assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
      assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    } finally {
      f.cleanup();
    }
  }
});

test("finite rounds: manual runs before and after exhaustion do not spend or reopen automatic quota", () => {
  const f = fixture();
  try {
    const schedule = f.store.createSchedule(input({ fireImmediately: false }), NOW);
    const runManual = (nowMs: number) => {
      const queued = f.store.enqueueManualInvocation(schedule.id, nowMs);
      const current = f.store.claimPendingInvocation(queued.id, "manual", nowMs);
      assert.ok(current);
      complete(f.store, current, nowMs + 1);
    };
    runManual(NOW);
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 0);
    const automatic = claim(f.store, NOW + INTERVAL);
    complete(f.store, automatic, NOW + INTERVAL + 1);
    runManual(NOW + INTERVAL + 2);
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    assert.equal(f.store.getSchedule(schedule.id)?.nextRunAtMs, undefined);
  } finally {
    f.cleanup();
  }
});

test("finite rounds: timeout reclassification reopens the last invocation without opening a new round", () => {
  const f = fixture({ retryBudget: 3, retryBackoffMs: 10 });
  try {
    const schedule = f.store.createSchedule(input(), NOW);
    const first = claim(f.store);
    complete(f.store, first, NOW + 1);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    assert.equal(
      f.store.reclassifyTimedOutInvocation({
        id: first.invocation.id,
        expectedAttempt: 1,
        error: "late timeout",
        timedOutAtMs: NOW,
        nowMs: NOW + 2,
      }),
      "retry-scheduled",
    );
    assert.equal(f.store.getSchedule(schedule.id)?.status, "active");
    assert.equal(f.store.getSchedule(schedule.id)?.nextRunAtMs, undefined);
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
    const retry = claim(f.store, NOW + 12);
    assert.equal(retry.invocation.id, first.invocation.id);
    complete(f.store, retry, NOW + 13);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    assert.equal(
      f.store.reclassifyTimedOutInvocation({
        id: first.invocation.id,
        expectedAttempt: 1,
        error: "stale timeout",
        timedOutAtMs: NOW,
        nowMs: NOW + 14,
      }),
      "lost-claim",
    );
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    assert.deepEqual(f.store.claimDue({ workerId: "later", nowMs: NOW + INTERVAL, limit: 20 }), []);
  } finally {
    f.cleanup();
  }
});

test("finite rounds: unknown tree liveness blocks final settlement until cleanup is proven", () => {
  let settled = false;
  const f = fixture({ treeLiveness: () => (settled ? "settled" : "unavailable") });
  try {
    const schedule = f.store.createSchedule(input(), NOW);
    const current = claim(f.store);
    assert.ok(f.store.beginInvocation(current.invocation.id, current.ownershipToken, NOW));
    assert.equal(
      f.store.recordInvocationTree({
        id: current.invocation.id,
        ownershipToken: current.ownershipToken,
        trackedGroups: [{ pgid: 900001, leaderState: "unknown" }],
        unsettled: true,
        survivorPids: [900002],
      }),
      true,
    );
    assert.equal(
      f.store.completeInvocation({
        id: current.invocation.id,
        ownershipToken: current.ownershipToken,
        status: "completed",
        nowMs: NOW + 1,
      }),
      "tree-unsettled",
    );
    assert.equal(f.store.getSchedule(schedule.id)?.status, "active");
    assert.equal(f.store.getSchedule(schedule.id)?.nextRunAtMs, undefined);
    assert.equal(
      f.store.cancelInvocation(current.invocation.id, "cancel", NOW + 2),
      "executor-unknown",
    );
    settled = true;
    complete(f.store, current, NOW + 3);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
  } finally {
    f.cleanup();
  }
});

test("finite rounds: automatic progress never borrows the status of a newer manual invocation", () => {
  const f = fixture();
  try {
    const schedule = f.store.createSchedule(input(), NOW);
    complete(f.store, claim(f.store), NOW + 1);
    const manual = f.store.enqueueManualInvocation(schedule.id, NOW + 2);
    const claimedManual = f.store.claimPendingInvocation(manual.id, "manual", NOW + 2);
    assert.ok(claimedManual);
    assert.equal(f.store.listInvocations(schedule.id)[0]?.mode, "manual");
    assert.deepEqual(f.store.getSchedule(schedule.id)?.lastScheduledRun, {
      status: "completed",
      treeUnsettled: false,
    });
    assert.deepEqual(readScheduleLedger(f.dir).schedules[0]?.lastScheduledRun, {
      status: "completed",
      treeUnsettled: false,
    });
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
    complete(f.store, claimedManual, NOW + 3);
  } finally {
    f.cleanup();
  }
});

test("finite rounds: restart, retention and missed periods preserve the durable counter", () => {
  const f = fixture({ invocationRetentionPerSchedule: 1, invocationRetentionMs: 1 });
  let reopened: ScheduleStore | undefined;
  let closed = false;
  try {
    const schedule = f.store.createSchedule(input({ maxRounds: 3 }), NOW);
    complete(f.store, claim(f.store), NOW + 1);
    complete(f.store, claim(f.store, NOW + 10 * INTERVAL), NOW + 10 * INTERVAL + 1);
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 2);
    assert.equal(f.store.pruneInvocations(NOW + 10 * INTERVAL + 100), 2);
    assert.equal(f.store.listInvocations(schedule.id).length, 0);
    f.store.close();
    closed = true;
    reopened = new ScheduleStore(f.dir);
    assert.equal(reopened.getSchedule(schedule.id)?.roundsStarted, 2);
    const last = claim(reopened, NOW + 20 * INTERVAL);
    complete(reopened, last, NOW + 20 * INTERVAL + 1);
    assert.equal(reopened.getSchedule(schedule.id)?.status, "completed");
    assert.equal(reopened.getSchedule(schedule.id)?.roundsStarted, 3);
  } finally {
    reopened?.close();
    if (closed) rmSync(f.dir, { recursive: true, force: true });
    else f.cleanup();
  }
});

test("finite rounds: a failed insertion transaction consumes no quota and preserves its due time", () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.dir, "schedules.db"));
  try {
    const schedule = f.store.createSchedule(input(), NOW);
    db.exec(
      "CREATE TRIGGER reject_round BEFORE INSERT ON invocations BEGIN SELECT RAISE(ABORT, 'round injection'); END",
    );
    assert.throws(() => claim(f.store), /round injection/u);
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 0);
    assert.equal(f.store.getSchedule(schedule.id)?.nextRunAtMs, NOW);
    assert.equal(f.store.listInvocations(schedule.id).length, 0);
    db.exec("DROP TRIGGER reject_round");
    complete(f.store, claim(f.store), NOW + 1);
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
  } finally {
    db.close();
    f.cleanup();
  }
});

test("finite rounds: idempotency distinguishes unlimited and each limit and never resets consumed quota", () => {
  const f = fixture();
  try {
    const finite = f.store.createScheduleIdempotent(input({ maxRounds: 2 }), NOW);
    complete(f.store, claim(f.store), NOW + 1);
    const replay = f.store.createScheduleIdempotent(input({ maxRounds: 2 }), NOW + 2);
    assert.equal(replay.created, false);
    assert.equal(replay.schedule.id, finite.schedule.id);
    assert.equal(replay.schedule.roundsStarted, 1);
    const { maxRounds: omitted, ...unlimitedInput } = input();
    assert.equal(omitted, 1);
    const unlimited = f.store.createScheduleIdempotent(unlimitedInput, NOW + 3);
    const other = f.store.createScheduleIdempotent(input({ maxRounds: 3 }), NOW + 4);
    assert.equal(unlimited.created, true);
    assert.equal(other.created, true);
    assert.equal(unlimited.schedule.maxRounds, undefined);
    f.store.removeSchedule(unlimited.schedule.id);
    f.store.removeSchedule(other.schedule.id);
    complete(f.store, claim(f.store, NOW + INTERVAL), NOW + INTERVAL + 1);
    assert.equal(
      f.store.createScheduleIdempotent(input({ maxRounds: 2 }), NOW + INTERVAL + 2).created,
      true,
    );
  } finally {
    f.cleanup();
  }
});

function createLegacyLedger(dir: string, version: 5 | 6) {
  const db = new DatabaseSync(join(dir, "schedules.db"));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
      trigger_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
      authority_digest TEXT, max_run_ms INTEGER, next_run_at INTEGER, last_run_at INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE invocations (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      mode TEXT NOT NULL, status TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      executor_pid INTEGER, executor_start_token TEXT, executor_probed_at INTEGER,
      claimed_by TEXT, ownership_token TEXT, lease_until INTEGER, retry_at INTEGER,
      thread_id TEXT, output_excerpt TEXT, error TEXT, pending_actions_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, tree_tracked_pgids TEXT,
      tree_unsettled INTEGER NOT NULL DEFAULT 0, tree_survivor_pids TEXT,
      UNIQUE (schedule_id, mode, scheduled_for));
    CREATE INDEX idx_schedules_due ON schedules (next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL;
    CREATE INDEX idx_invocations_live ON invocations (schedule_id) WHERE status IN ('pending', 'claimed', 'running', 'retry');
    INSERT INTO schedules VALUES ('legacy', 'legacy name', 'prompt', '/workspace/legacy',
      '{"kind":"interval","everyMs":60000}', 'active', 'authority', 120000, 1, NULL, NULL, 1, 1);
    INSERT INTO invocations (id, schedule_id, mode, status, scheduled_for, attempt, thread_id,
      tree_tracked_pgids, tree_unsettled, tree_survivor_pids, created_at)
      VALUES ('legacy-run', 'legacy', 'scheduled', 'retry', 1, 1, 'legacy-thread', '[4242]', 1, '[4243]', 1);
    PRAGMA user_version = ${String(version)};
  `);
  if (version === 6) {
    db.exec(`CREATE TABLE schedule_thread_refs (
      invocation_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt > 0), schedule_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, threads_dir TEXT NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL,
      scheduled_for INTEGER NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('scheduled', 'manual')),
      created_at INTEGER NOT NULL, PRIMARY KEY (invocation_id, attempt));
      CREATE INDEX idx_schedule_thread_refs_history ON schedule_thread_refs (schedule_id, scheduled_for DESC, invocation_id, attempt DESC);
      INSERT INTO schedule_thread_refs VALUES ('legacy-run', 1, 'legacy', 'legacy-thread', '/workspace/threads', 'legacy name', '/workspace/legacy', 1, 'scheduled', 1);`);
  }
  db.close();
}

test("finite rounds: pausing a last-round retry waits for unresolved trees before ending", () => {
  let settled = false;
  const f = fixture({
    retryBackoffMs: 10,
    claimLeaseMs: 10,
    treeLiveness: () => (settled ? "settled" : "unsettled"),
  });
  try {
    const schedule = f.store.createSchedule(input(), NOW);
    const current = claim(f.store);
    assert.ok(f.store.beginInvocation(current.invocation.id, current.ownershipToken, NOW));
    f.store.recordInvocationTree({
      id: current.invocation.id,
      ownershipToken: current.ownershipToken,
      trackedGroups: [{ pgid: 900003, leaderState: "unknown" }],
      unsettled: true,
    });
    assert.equal(
      f.store.failInvocation(current.invocation.id, current.ownershipToken, "retry", NOW + 1),
      "retry-scheduled",
    );
    f.store.setScheduleStatus(schedule.id, "paused", NOW + 2);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "paused");
    assert.equal(f.store.getInvocation(current.invocation.id)?.status, "retry");
    assert.equal(f.store.getSchedule(schedule.id)?.nextRunAtMs, undefined);
    assert.deepEqual(f.store.claimDue({ workerId: "cleanup", nowMs: NOW + 1_000, limit: 20 }), []);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "paused");
    settled = true;
    assert.deepEqual(f.store.claimDue({ workerId: "cleanup", nowMs: NOW + 2_000, limit: 20 }), []);
    assert.equal(f.store.getInvocation(current.invocation.id)?.status, "failed");
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
  } finally {
    f.cleanup();
  }
});

test("finite rounds: exhausted expired claim and worker shutdown both settle the last round", () => {
  for (const outcome of ["expired", "shutdown"] as const) {
    const f = fixture({ retryBudget: 1, claimLeaseMs: 1_000 });
    try {
      const schedule = f.store.createSchedule(input(), NOW);
      const current = claim(f.store);
      if (outcome === "expired") {
        assert.deepEqual(
          f.store.claimDue({ workerId: "replacement", nowMs: NOW + 1_001, limit: 20 }),
          [],
        );
      } else {
        assert.deepEqual(f.store.prepareWorkerShutdown("rounds-test", "stop", NOW + 1), []);
      }
      assert.equal(f.store.getInvocation(current.invocation.id)?.status, "failed");
      assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
      assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
    } finally {
      f.cleanup();
    }
  }
});

test("finite rounds: unspecified quota continues beyond twenty rounds", () => {
  const f = fixture();
  try {
    const { maxRounds: omitted, ...unlimited } = input();
    assert.equal(omitted, 1);
    const schedule = f.store.createSchedule(unlimited, NOW);
    for (let round = 0; round < 21; round += 1) {
      complete(f.store, claim(f.store, NOW + round * INTERVAL), NOW + round * INTERVAL + 1);
    }
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 21);
    assert.equal(f.store.getSchedule(schedule.id)?.status, "active");
    assert.equal(f.store.getSchedule(schedule.id)?.nextRunAtMs, NOW + 21 * INTERVAL);
  } finally {
    f.cleanup();
  }
});

test("finite rounds: an expired last attempt stays occupied while executor identity is unknown", () => {
  let dead = false;
  const f = fixture({
    retryBudget: 1,
    claimLeaseMs: 1_000,
    executorLiveness: () => (dead ? "dead" : "unknown"),
  });
  try {
    const schedule = f.store.createSchedule(input(), NOW);
    const current = claim(f.store);
    assert.ok(
      f.store.beginInvocation(current.invocation.id, current.ownershipToken, NOW, {
        pid: 900004,
        startToken: "pst-v2:test-only",
      }),
    );
    assert.deepEqual(
      f.store.claimDue({ workerId: "replacement", nowMs: NOW + 1_001, limit: 20 }),
      [],
    );
    assert.equal(f.store.getInvocation(current.invocation.id)?.status, "running");
    assert.equal(f.store.getSchedule(schedule.id)?.status, "active");
    assert.equal(f.store.getSchedule(schedule.id)?.roundsStarted, 1);
    assert.equal(f.store.getSchedule(schedule.id)?.nextRunAtMs, undefined);
    assert.equal(
      f.store.cancelInvocation(current.invocation.id, "cancel", NOW + 1_002),
      "executor-unknown",
    );
    dead = true;
    assert.deepEqual(
      f.store.claimDue({ workerId: "replacement", nowMs: NOW + 2_002, limit: 20 }),
      [],
    );
    assert.equal(f.store.getInvocation(current.invocation.id)?.status, "failed");
    assert.equal(f.store.getSchedule(schedule.id)?.status, "completed");
  } finally {
    f.cleanup();
  }
});

test("finite rounds: failed legacy migration rolls back schema, rows and user version", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-rounds-rollback-"));
  try {
    createLegacyLedger(dir, 6);
    const corrupt = new DatabaseSync(join(dir, "schedules.db"));
    corrupt.exec("PRAGMA foreign_keys = OFF; UPDATE invocations SET schedule_id = 'missing';");
    const beforeSchema = corrupt
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name")
      .all();
    const beforeSchedules = corrupt.prepare("SELECT * FROM schedules").all();
    const beforeRuns = corrupt.prepare("SELECT * FROM invocations").all();
    const beforeRefs = corrupt.prepare("SELECT * FROM schedule_thread_refs").all();
    corrupt.close();
    assert.throws(() => new ScheduleStore(dir), /迁移|外键/u);
    const check = new DatabaseSync(join(dir, "schedules.db"), { readOnly: true });
    try {
      assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 6);
      assert.deepEqual(
        check.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
        beforeSchema,
      );
      assert.deepEqual(check.prepare("SELECT * FROM schedules").all(), beforeSchedules);
      assert.deepEqual(check.prepare("SELECT * FROM invocations").all(), beforeRuns);
      assert.deepEqual(check.prepare("SELECT * FROM schedule_thread_refs").all(), beforeRefs);
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finite rounds: a constructor waiting behind another upgrade preserves committed v7 quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-rounds-migration-race-"));
  createLegacyLedger(dir, 6);
  const writer = new DatabaseSync(join(dir, "schedules.db"));
  writer.exec("BEGIN IMMEDIATE");
  const source = [
    'import { DatabaseSync } from "node:sqlite";',
    `import { ScheduleStore } from ${JSON.stringify(new URL("./schedule-store.ts", import.meta.url).href)};`,
    "const originalExec = DatabaseSync.prototype.exec;",
    "DatabaseSync.prototype.exec = function (sql) {",
    '  if (sql === "BEGIN IMMEDIATE") process.stdout.write("waiting\\n");',
    "  return originalExec.call(this, sql);",
    "};",
    "const store = new ScheduleStore(process.argv[1]);",
    'process.stdout.write(JSON.stringify(store.getSchedule("legacy")) + "\\n");',
    "store.close();",
  ].join("\n");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--experimental-sqlite",
      "--input-type=module",
      "-e",
      source,
      dir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => {
        if (output.includes("waiting")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`constructor exited before waiting: ${errors}`)));
    });
    // Simulate a concurrent upgrader committing the new columns and live quota
    // after the waiting process read v6, but before it acquires the writer lock.
    writer.exec(`ALTER TABLE schedules ADD COLUMN max_rounds INTEGER;
      ALTER TABLE schedules ADD COLUMN rounds_started INTEGER NOT NULL DEFAULT 0;
      UPDATE schedules SET max_rounds = 3, rounds_started = 1;
      PRAGMA user_version = 7;
      COMMIT;`);
    const [code] = await exited;
    assert.equal(code, 0, errors);
    const result = JSON.parse(output.trim().split("\n").at(-1) ?? "null") as unknown;
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "maxRounds" in result &&
        "roundsStarted" in result,
    );
    assert.equal(result.maxRounds, 3);
    assert.equal(result.roundsStarted, 1);
  } finally {
    child.kill();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const version of [5, 6] as const) {
  test(`finite rounds: readonly v${String(version)} and v8 preserve legacy data and migration keeps foreign keys`, () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-rounds-legacy-"));
    let store: ScheduleStore | undefined;
    try {
      createLegacyLedger(dir, version);
      const before = readFileSync(join(dir, "schedules.db"));
      const legacy = readScheduleLedger(dir);
      assert.equal(legacy.status, "ok");
      assert.equal(legacy.schedules[0]?.maxRounds, undefined);
      assert.equal(legacy.schedules[0]?.roundsStarted, 0);
      const history = readScheduleHistory(dir, { scheduleId: "legacy" });
      assert.equal(history.status, "ok");
      if (version === 6) assert.equal(history.runs[0]?.references[0]?.threadId, "legacy-thread");
      assert.deepEqual(
        readFileSync(join(dir, "schedules.db")),
        before,
        "readonly access must not migrate",
      );
      store = new ScheduleStore(dir);
      assert.equal(store.getSchedule("legacy")?.maxRunMs, 120_000);
      assert.equal(store.getSchedule("legacy")?.maxRounds, undefined);
      assert.equal(store.getSchedule("legacy")?.roundsStarted, 0);
      assert.deepEqual(store.getInvocation("legacy-run")?.treeTrackedPgids, [4242]);
      assert.deepEqual(store.getInvocation("legacy-run")?.treeSurvivorPids, [4243]);
      assert.equal(store.getInvocation("legacy-run")?.treeUnsettled, true);
      assert.equal(readScheduleLedger(dir).status, "ok");
      const migrated = new DatabaseSync(join(dir, "schedules.db"));
      assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, 8);
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
      if (version === 6) {
        assert.equal(
          migrated.prepare("SELECT thread_id FROM schedule_thread_refs").get()?.thread_id,
          "legacy-thread",
        );
      }
      migrated.exec("PRAGMA foreign_keys = ON");
      migrated.prepare("DELETE FROM schedules WHERE id = ?").run("legacy");
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM invocations").get()?.count, 0);
      migrated.close();
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
