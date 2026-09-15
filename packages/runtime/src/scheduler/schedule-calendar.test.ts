import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "./database-fixture.test.ts";
import { ScheduleStore, readScheduleLedger } from "./schedule-store.ts";
import { createScheduleTrigger } from "./trigger.ts";
import type { ClaimedInvocation } from "./types.ts";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const START = Date.parse("2026-09-16T00:00:00Z");
const HALF_HOUR = 1_800_000;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "roll-calendar-"));
  const store = new ScheduleStore(dir);
  return {
    dir,
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function finish(store: ScheduleStore, claim: ClaimedInvocation, nowMs: number) {
  assert.equal(
    store.completeInvocation({
      id: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      status: "completed",
      nowMs,
    }),
    "written",
  );
}
function input() {
  return {
    name: "明早巡检",
    prompt: "检查未读消息",
    cwd: "/workspace",
    maxRounds: 20,
    trigger: createScheduleTrigger({ every: "30m", startAt: "2026-09-16T08:00:00+08:00" }, NOW),
  };
}

test("calendar store: tomorrow 08:00, 30m, exactly 20 rounds across restart and competing claims", () => {
  const f = fixture();
  const second = new ScheduleStore(f.dir);
  try {
    const record = f.store.createSchedule(input(), NOW);
    assert.equal(record.nextRunAtMs, START);
    assert.deepEqual(second.claimDue({ workerId: "second", nowMs: START - 1, limit: 1 }), []);
    for (let round = 0; round < 20; round++) {
      const clock = START + round * HALF_HOUR;
      const active = round % 2 === 0 ? f.store : second;
      const rival = round % 2 === 0 ? second : f.store;
      const claim = active.claimDue({ workerId: "active", nowMs: clock, limit: 1 })[0];
      assert.ok(claim);
      assert.equal(claim.invocation.scheduledForMs, clock);
      assert.deepEqual(rival.claimDue({ workerId: "rival", nowMs: clock, limit: 1 }), []);
      assert.equal(active.getSchedule(record.id)?.roundsStarted, round + 1);
      finish(active, claim, clock + 1);
    }
    assert.equal(second.getSchedule(record.id)?.status, "completed");
    assert.deepEqual(
      second.claimDue({ workerId: "later", nowMs: START + 100 * HALF_HOUR, limit: 100 }),
      [],
    );
    const reopened = new ScheduleStore(f.dir);
    try {
      assert.equal(reopened.getSchedule(record.id)?.roundsStarted, 20);
    } finally {
      reopened.close();
    }
  } finally {
    second.close();
    f.close();
  }
});

test("calendar store: missed days catch up once, retry spends no extra round, next run realigns", () => {
  const f = fixture();
  try {
    const record = f.store.createSchedule(
      {
        ...input(),
        trigger: createScheduleTrigger(
          {
            calendar: {
              frequency: "daily",
              time: "08:00",
              timeZone: "Asia/Shanghai",
            },
            startAt: "2026-09-16T08:00",
          },
          NOW,
        ),
      },
      NOW,
    );
    const later = Date.parse("2026-09-20T01:00:00Z");
    const claim = f.store.claimDue({ workerId: "first", nowMs: later, limit: 10 })[0];
    assert.ok(claim);
    assert.equal(claim.invocation.scheduledForMs, START);
    assert.equal(f.store.getSchedule(record.id)?.roundsStarted, 1);
    assert.equal(f.store.getSchedule(record.id)?.nextRunAtMs, Date.parse("2026-09-21T00:00:00Z"));
    f.store.failInvocation(claim.invocation.id, claim.ownershipToken, "retry", later + 1);
    const retry = f.store.claimDue({ workerId: "retry", nowMs: later + HALF_HOUR, limit: 10 })[0];
    assert.ok(retry);
    assert.equal(retry.invocation.id, claim.invocation.id);
    assert.equal(f.store.getSchedule(record.id)?.roundsStarted, 1);
    finish(f.store, retry, later + HALF_HOUR + 1);
    assert.deepEqual(
      f.store.claimDue({ workerId: "again", nowMs: later + HALF_HOUR + 2, limit: 10 }),
      [],
    );
  } finally {
    f.close();
  }
});

test("calendar store: full normalized timing is part of idempotency", () => {
  const f = fixture();
  try {
    const base = {
      ...input(),
      trigger: createScheduleTrigger(
        {
          calendar: {
            frequency: "weekly",
            time: "08:00",
            weekdays: [3, 1],
            timeZone: "Asia/Shanghai",
          },
        },
        NOW,
      ),
    };
    const first = f.store.createScheduleIdempotent(base, NOW);
    const same = f.store.createScheduleIdempotent(
      {
        ...base,
        trigger: createScheduleTrigger(
          {
            calendar: {
              frequency: "weekly",
              time: "08:00",
              weekdays: [1, 3, 1],
              timeZone: "Asia/Shanghai",
            },
          },
          NOW,
        ),
      },
      NOW,
    );
    assert.equal(same.created, false);
    assert.equal(same.schedule.id, first.schedule.id);
    for (const trigger of [
      createScheduleTrigger(
        {
          calendar: {
            frequency: "weekly",
            time: "08:00",
            weekdays: [1, 3],
            timeZone: "Europe/London",
          },
        },
        NOW,
      ),
      createScheduleTrigger(
        {
          calendar: {
            frequency: "weekly",
            time: "08:00",
            weekdays: [1, 3],
            timeZone: "Asia/Shanghai",
          },
          startAt: "2026-09-17T08:00",
        },
        NOW,
      ),
    ]) {
      assert.equal(f.store.createScheduleIdempotent({ ...base, trigger }, NOW).created, true);
    }
  } finally {
    f.close();
  }
});

test("calendar store: invalid starts and now conflicts do not insert", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.createSchedule(input(), START));
    assert.throws(() => f.store.createSchedule({ ...input(), fireImmediately: true }, NOW));
    assert.throws(() =>
      f.store.createSchedule(
        {
          ...input(),
          fireImmediately: true,
          trigger: createScheduleTrigger({ calendar: { frequency: "daily", time: "08:00" } }, NOW),
        },
        NOW,
      ),
    );
    assert.equal(f.store.listSchedules().length, 0);
    const trigger = createScheduleTrigger(
      { calendar: { frequency: "daily", time: "08:00", timeZone: "Asia/Shanghai" } },
      NOW,
    );
    assert.throws(
      () => f.store.createSchedule({ ...input(), trigger, expectedFirstRunAtMs: START }, START + 1),
      /重新发起确认/u,
    );
    assert.equal(f.store.listSchedules().length, 0);
  } finally {
    f.close();
  }
});

test("calendar store: readonly v8 stays v8, writer upgrades to v9 preserving old rules", () => {
  const f = fixture();
  try {
    const record = f.store.createSchedule(
      { ...input(), trigger: { kind: "interval", everyMs: HALF_HOUR } },
      NOW,
    );
    const raw = new DatabaseSync(join(f.dir, "schedules.db"));
    try {
      raw.exec("PRAGMA user_version = 8");
      assert.equal(readScheduleLedger(f.dir).schedules[0]?.id, record.id);
      assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, 8);
      const reopened = new ScheduleStore(f.dir);
      try {
        assert.equal(reopened.getSchedule(record.id)?.nextRunAtMs, NOW + HALF_HOUR);
        assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, 9);
      } finally {
        reopened.close();
      }
    } finally {
      raw.close();
    }
  } finally {
    f.close();
  }
});

test("calendar store: pause/resume and extending completed quota retain timezone and calendar alignment", () => {
  const f = fixture();
  try {
    const record = f.store.createSchedule(
      {
        ...input(),
        maxRounds: 1,
        trigger: createScheduleTrigger(
          {
            calendar: {
              frequency: "weekly",
              time: "08:00",
              weekdays: [3],
              timeZone: "Asia/Shanghai",
            },
            startAt: "2026-09-16T08:00",
          },
          NOW,
        ),
      },
      NOW,
    );
    f.store.setScheduleStatus(record.id, "paused", NOW + 1);
    assert.deepEqual(f.store.claimDue({ workerId: "paused", nowMs: START, limit: 1 }), []);
    f.store.resumeSchedule(record.id, "digest", START + 1);
    const claim = f.store.claimDue({ workerId: "resumed", nowMs: START + 2, limit: 1 })[0];
    assert.ok(claim);
    finish(f.store, claim, START + 3);
    assert.equal(f.store.getSchedule(record.id)?.status, "completed");
    const extended = f.store.extendSchedule(
      {
        scheduleId: record.id,
        expectedMaxRounds: 1,
        additionalRounds: 1,
        requestId: "calendar-extension",
        authorityDigest: "digest",
      },
      START + HALF_HOUR,
    );
    assert.equal(extended.schedule.nextRunAtMs, Date.parse("2026-09-23T00:00:00Z"));
    assert.deepEqual(extended.schedule.trigger, record.trigger);
    assert.equal(extended.schedule.roundsStarted, 1);
  } finally {
    f.close();
  }
});
