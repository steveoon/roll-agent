import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScheduleRow } from "../types.ts";
import { prepareScheduleExtension } from "./schedule-extension.ts";

const schedule: ScheduleRow = {
  id: "task",
  name: "检查",
  status: "completed",
  trigger: "每 30 分钟",
  cwd: "/workspace/task",
  prompt: "完整检查任务",
  createdAt: "2026-09-10T00:00:00Z",
  rounds: { max: 20, started: 20 },
  roundsDisplay: "已结束 · 20/20 轮",
};

test("extension confirmation includes exact preserved task and before/after limits", () => {
  const result = prepareScheduleExtension(schedule, "30", undefined, () => "request-1");
  assert.deepEqual(result.request, {
    id: "task",
    rounds: 30,
    expectedMaxRounds: 20,
    requestId: "request-1",
  });
  for (const expected of [
    "20 → 50",
    "已执行：20",
    "剩余：30",
    schedule.cwd,
    schedule.prompt,
    "重新授权",
    "等待一个周期",
  ]) {
    assert.ok(result.confirmation.includes(expected), expected);
  }
});

test("ambiguous network failure reuses original request after refreshed schedule becomes active", () => {
  const first = prepareScheduleExtension(schedule, "30", undefined, () => "request-1");
  const refreshed = { ...schedule, status: "active", rounds: { max: 50, started: 20 } };
  assert.equal(
    prepareScheduleExtension(refreshed, "30", first, () => "must-not-generate"),
    first,
  );
  assert.throws(() => prepareScheduleExtension(refreshed, "31", first, () => "new"), /原轮数重试/u);
});

test("changing amount before success creates a new request and confirmation", () => {
  const first = prepareScheduleExtension(schedule, "30", undefined, () => "request-1");
  const next = prepareScheduleExtension(schedule, "40", first, () => "request-2");
  assert.equal(next.request.requestId, "request-2");
  assert.equal(next.request.expectedMaxRounds, 20);
  assert.match(next.confirmation, /20 → 60/u);
});

test("invalid input, overflow and known unfinished runs never create an extension request", () => {
  for (const amount of ["", "0", "-1", "1.5", "2e2", "20x", "9007199254740992"]) {
    assert.throws(
      () => prepareScheduleExtension(schedule, amount, undefined, () => "id"),
      /正整数/u,
    );
  }
  assert.throws(
    () =>
      prepareScheduleExtension(
        { ...schedule, rounds: { max: Number.MAX_SAFE_INTEGER, started: Number.MAX_SAFE_INTEGER } },
        "1",
        undefined,
        () => "id",
      ),
    /安全整数范围/u,
  );
  assert.throws(
    () =>
      prepareScheduleExtension(
        { ...schedule, liveRun: { id: "manual", mode: "manual", status: "running" } },
        "30",
        undefined,
        () => "id",
      ),
    /未结算/u,
  );
  assert.throws(
    () => prepareScheduleExtension({ ...schedule, status: "paused" }, "30", undefined, () => "id"),
    /已结束/u,
  );
});
