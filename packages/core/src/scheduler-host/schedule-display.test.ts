import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduleRecord } from "@roll-agent/runtime";
import { describeScheduleTiming } from "./schedule-display.ts";

test("calendar display uses the saved zone and explicit labels, independent of the client clock", () => {
  const record: ScheduleRecord = {
    id: "test",
    name: "test",
    prompt: "noop",
    cwd: "/workspace",
    status: "active",
    trigger: {
      kind: "calendar",
      calendar: { frequency: "daily", time: "08:00", timeZone: "America/New_York" },
    },
    nextRunAtMs: Date.parse("2026-09-16T12:00:00Z"),
    lastRunAtMs: Date.parse("2026-09-15T12:00:00Z"),
    maxRunMs: undefined,
    maxRounds: 20,
    roundsStarted: 1,
    authorityDigest: undefined,
    lastError: undefined,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  const display = describeScheduleTiming(record);
  assert.match(display.nextRunAtDisplay ?? "", /08:00:00（America\/New_York）/u);
  assert.match(display.lastRunAtDisplay ?? "", /08:00:00（America\/New_York）/u);
  assert.equal(display.timeZone, "America/New_York");
});
