import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduleRecord } from "@roll-agent/runtime";
import { describeScheduleRounds, parseScheduleRounds } from "./schedule-rounds.ts";

const record: ScheduleRecord = {
  id: "finite",
  name: "巡检",
  prompt: "检查",
  cwd: "/tmp",
  trigger: { kind: "interval", everyMs: 60_000 },
  status: "active",
  maxRounds: 20,
  roundsStarted: 7,
  authorityDigest: undefined,
  maxRunMs: undefined,
  nextRunAtMs: undefined,
  lastRunAtMs: undefined,
  lastError: undefined,
  createdAtMs: 0,
  updatedAtMs: 0,
};

test("rounds progress distinguishes quota exhaustion, retry, tree cleanup and completion", () => {
  assert.equal(describeScheduleRounds(record), "已触发 7/20 轮");
  assert.equal(describeScheduleRounds({ ...record, maxRounds: undefined }), "不限轮数");
  const exhausted = { ...record, roundsStarted: 20 };
  for (const [status, label] of [
    ["claimed", "等待执行"],
    ["running", "执行中"],
    ["retry", "等待重试"],
  ] as const) {
    assert.equal(
      describeScheduleRounds({ ...exhausted, lastScheduledRun: { status, treeUnsettled: false } }),
      `20/20 轮已触发 · 最后一轮${label}`,
    );
  }
  assert.equal(
    describeScheduleRounds({
      ...exhausted,
      lastScheduledRun: { status: "retry", treeUnsettled: true },
    }),
    "20/20 轮已触发 · 最后一轮等待清场",
  );
  assert.equal(
    describeScheduleRounds({ ...exhausted, status: "completed" }),
    "已结束 · 达到轮数上限 · 20/20 轮",
  );
});

test("CLI rounds parser accepts positive safe integers and rejects partial or unsafe input", () => {
  assert.equal(parseScheduleRounds("20"), 20);
  assert.equal(parseScheduleRounds(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const input of ["", "0", "-1", "1.5", "20x", "1e2", "Infinity", "9007199254740992"]) {
    assert.throws(() => parseScheduleRounds(input), /正安全整数/u);
  }
});
