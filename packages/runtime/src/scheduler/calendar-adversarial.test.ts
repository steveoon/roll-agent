import assert from "node:assert/strict";
import test from "node:test";
import {
  createScheduleTrigger,
  computeNextRunAtMs,
  computeFirstRunAtMs,
  parseTriggerJson,
  triggerSpecSchema,
} from "./trigger.ts";
import {
  nextCalendarRunAtMs,
  calendarScheduleInputSchema,
  type CalendarSchedule,
} from "./calendar.ts";
import { zodSchema } from "ai";

// Independent oracle: enumerate UTC minutes and inspect their local labels. No offset inversion.
function enumerate(calendar: CalendarSchedule, after: number): number {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: calendar.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const seen = new Set<string>();
  for (
    let instant = Math.floor(after / 60_000) * 60_000 - 2 * 86_400_000;
    instant < after + 16 * 86_400_000;
    instant += 60_000
  ) {
    const label = formatter.format(instant);
    const date = label.slice(0, 10);
    if (label.slice(-5) !== calendar.time || seen.has(date)) continue;
    seen.add(date);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    if (
      instant > after &&
      (calendar.frequency === "daily" || calendar.weekdays.includes(weekday))
    ) {
      return instant;
    }
  }
  throw new Error("oracle found no occurrence");
}

for (const [timeZone, after, time] of [
  ["America/New_York", "2026-11-01T05:30:00Z", "01:30"],
  ["America/New_York", "2026-03-08T05:00:00Z", "02:30"],
  ["Australia/Lord_Howe", "2026-04-04T15:00:00Z", "01:45"],
  ["Australia/Lord_Howe", "2026-10-03T14:00:00Z", "02:15"],
  ["Pacific/Apia", "2011-12-29T23:00:00Z", "08:00"],
  ["Pacific/Chatham", "2026-09-26T12:00:00Z", "03:00"],
  ["Africa/Casablanca", "2026-02-15T01:30:00Z", "02:30"],
  ["Asia/Kathmandu", "2028-02-28T23:59:59.999Z", "00:00"],
  ["Pacific/Kiritimati", "2026-12-31T09:59:59.999Z", "00:00"],
] as const) {
  for (const frequency of ["daily", "weekly"] as const) {
    test(`UTC oracle ${timeZone} ${after} ${frequency}`, () => {
      const calendar: CalendarSchedule =
        frequency === "daily"
          ? { frequency, timeZone, time }
          : { frequency, timeZone, time, weekdays: [1, 7] };
      assert.equal(
        nextCalendarRunAtMs(calendar, Date.parse(after)),
        enumerate(calendar, Date.parse(after)),
      );
    });
  }
}

test("equivalent timezone aliases normalize to one persisted trigger", () => {
  const timing = (timeZone: string) =>
    createScheduleTrigger({ calendar: { frequency: "daily", time: "08:00", timeZone } });
  assert.deepEqual(timing("Asia/Kolkata"), timing("Asia/Calcutta"));
});

test("persisted calendar requires explicit timezone in all schema entrypoints", () => {
  assert.throws(() =>
    parseTriggerJson('{"kind":"calendar","calendar":{"frequency":"daily","time":"08:00"}}'),
  );
  assert.equal(
    triggerSpecSchema.safeParse({
      kind: "calendar",
      calendar: { frequency: "daily", time: "08:00" },
    }).success,
    false,
  );
});

test("model calendar input schema has no captured machine-specific timezone default", async () => {
  const schema = await zodSchema(calendarScheduleInputSchema).jsonSchema;
  assert.doesNotMatch(JSON.stringify(schema), /"default"/u);
  assert.deepEqual(calendarScheduleInputSchema.parse({ frequency: "daily", time: "08:00" }), {
    frequency: "daily",
    time: "08:00",
  });
});

test("late interval claims keep elapsed-time semantics and exact first-time boundaries", () => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  const trigger = createScheduleTrigger(
    { every: "30m", startAt: "2026-09-16T08:00:00+08:00" },
    now,
  );
  assert.equal(
    computeNextRunAtMs(trigger, Date.parse("2026-09-16T00:07:00Z")),
    Date.parse("2026-09-16T00:37:00Z"),
  );
});

test("equivalent timestamp offsets and saved timezone survive a machine timezone change", () => {
  const previous = process.env.TZ;
  const now = Date.parse("2026-09-15T00:00:00Z");
  try {
    process.env.TZ = "Asia/Shanghai";
    const first = createScheduleTrigger(
      { every: "30m", startAt: "2026-09-16T08:00:00+08:00" },
      now,
    );
    assert.deepEqual(
      first,
      createScheduleTrigger({ every: "30m", startAt: "2026-09-16T00:00:00Z" }, now),
    );
    const calendar = createScheduleTrigger(
      { calendar: { frequency: "daily", time: "08:00" } },
      now,
    );
    const json = JSON.stringify(calendar);
    process.env.TZ = "America/New_York";
    assert.deepEqual(parseTriggerJson(json), calendar);
    assert.equal(
      computeNextRunAtMs(parseTriggerJson(json), now),
      Date.parse("2026-09-16T00:00:00Z"),
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("leap day, month boundary, and supported start timestamp bounds", () => {
  const calendar: CalendarSchedule = { frequency: "daily", time: "00:00", timeZone: "UTC" };
  assert.equal(
    nextCalendarRunAtMs(calendar, Date.parse("2028-02-28T23:59:59.999Z")),
    Date.parse("2028-02-29T00:00:00Z"),
  );
  assert.equal(
    nextCalendarRunAtMs(calendar, Date.parse("2028-02-29T00:00:00Z")),
    Date.parse("2028-03-01T00:00:00Z"),
  );
  const upper = 253_402_214_400_000;
  for (const startAtMs of [-1, upper + 1, NaN, Infinity, 0.5]) {
    assert.equal(
      triggerSpecSchema.safeParse({ kind: "interval", everyMs: 60_000, startAtMs }).success,
      false,
    );
  }
  for (const startAtMs of [0, upper]) {
    const trigger = triggerSpecSchema.parse({ kind: "interval", everyMs: 60_000, startAtMs });
    assert.equal(computeFirstRunAtMs(trigger, startAtMs - 1), startAtMs);
    assert.throws(() => computeFirstRunAtMs(trigger, startAtMs));
  }
});
