import assert from "node:assert/strict";
import test from "node:test";
import {
  computeFirstRunAtMs,
  computeNextRunAtMs,
  createScheduleTrigger,
  parseTriggerJson,
} from "./trigger.ts";
import { systemTimeZone } from "./calendar.ts";

const ms = (iso: string) => Date.parse(iso);
const NOW = ms("2026-09-15T00:00:00Z");

test("future interval starts exactly at startAt, then uses elapsed intervals", () => {
  const t = createScheduleTrigger({ every: "30m", startAt: "2026-09-16T08:00:00+08:00" }, NOW);
  assert.equal(computeFirstRunAtMs(t, NOW), ms("2026-09-16T00:00:00Z"));
  assert.equal(computeNextRunAtMs(t, ms("2026-09-16T00:00:03Z")), ms("2026-09-16T00:30:03Z"));
  assert.deepEqual(parseTriggerJson(JSON.stringify(t)), t);
});

test("calendar captures the host zone by default; explicit zone overrides it", () => {
  const t = createScheduleTrigger({ calendar: { frequency: "daily", time: "08:00" } }, NOW);
  assert.equal(t.kind, "calendar");
  if (t.kind === "calendar") assert.equal(t.calendar.timeZone, systemTimeZone());
  const explicit = createScheduleTrigger(
    {
      calendar: { frequency: "daily", time: "08:00", timeZone: "Asia/Shanghai" },
      startAt: "2026-09-16T08:00",
    },
    NOW,
  );
  assert.equal(computeFirstRunAtMs(explicit, NOW), ms("2026-09-16T00:00:00Z"));
  assert.equal(
    computeNextRunAtMs(explicit, ms("2026-09-16T00:00:03Z")),
    ms("2026-09-17T00:00:00Z"),
  );
});

for (const [zone, time, after, expected] of [
  ["America/New_York", "02:30", "2026-03-08T05:00:00Z", "2026-03-09T06:30:00Z"],
  ["America/New_York", "01:30", "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z"],
  ["America/New_York", "01:30", "2026-11-01T05:30:00Z", "2026-11-02T06:30:00Z"],
  ["Australia/Lord_Howe", "02:15", "2026-10-03T14:00:00Z", "2026-10-04T15:15:00Z"],
  ["Asia/Kathmandu", "00:00", "2026-09-15T18:14:59Z", "2026-09-15T18:15:00Z"],
] as const) {
  test(`calendar wall time ${zone} ${time} after ${after}`, () => {
    const t = createScheduleTrigger(
      { calendar: { frequency: "daily", time, timeZone: zone } },
      ms(after),
    );
    assert.equal(computeNextRunAtMs(t, ms(after)), ms(expected));
  });
}

test("weekly weekdays normalize, skip downtime, and survive JSON roundtrip", () => {
  const t = createScheduleTrigger(
    {
      calendar: {
        frequency: "weekly",
        weekdays: [5, 1, 1],
        time: "08:00",
        timeZone: "Asia/Shanghai",
      },
    },
    NOW,
  );
  assert.equal(computeNextRunAtMs(t, NOW), ms("2026-09-18T00:00:00Z"));
  assert.equal(computeNextRunAtMs(t, ms("2026-09-18T01:00:00Z")), ms("2026-09-21T00:00:00Z"));
  assert.deepEqual(parseTriggerJson(JSON.stringify(t)), t);
  assert.equal(t.kind, "calendar");
  if (t.kind === "calendar" && t.calendar.frequency === "weekly") {
    assert.deepEqual(t.calendar.weekdays, [1, 5]);
  }
});

test("invalid timing rejects missing/conflicting frequency, bad zones/dates and past start", () => {
  for (const input of [
    {},
    { every: "30m", calendar: { frequency: "daily", time: "08:00" } },
    { calendar: { frequency: "weekly", time: "08:00", weekdays: [] } },
    { calendar: { frequency: "daily", time: "25:00" } },
    { calendar: { frequency: "daily", time: "08:00", timeZone: "Not/AZone" } },
    { every: "30m", startAt: "2026-09-14T08:00" },
    { every: "30m", startAt: "2026-09-31T08:00" },
    { every: "30m", startAt: "2026-09-31T08:00:00Z" },
  ]) {
    assert.throws(() =>
      createScheduleTrigger(input as Parameters<typeof createScheduleTrigger>[0], NOW),
    );
  }
  assert.throws(() =>
    createScheduleTrigger(
      {
        calendar: { frequency: "daily", time: "02:30", timeZone: "America/New_York" },
        startAt: "2027-03-14T02:30",
      },
      NOW,
    ),
  );
});

test("persisted calendar without a zone never inherits the reader's current machine zone", () => {
  assert.throws(
    () =>
      parseTriggerJson(
        JSON.stringify({ kind: "calendar", calendar: { frequency: "daily", time: "08:00" } }),
      ),
    /timeZone/u,
  );
});
