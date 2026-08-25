import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULER_LIMITS } from "./limits.ts";
import {
  ScheduleTriggerError,
  computeNextRunAtMs,
  createIntervalTrigger,
  describeTrigger,
  formatInterval,
  parseIntervalText,
  parseTriggerJson,
} from "./trigger.ts";

test("parseIntervalText 解析 s/m/h/d", () => {
  assert.equal(parseIntervalText("30m"), 1_800_000);
  assert.equal(parseIntervalText(" 2h "), 7_200_000);
  assert.equal(parseIntervalText("1d"), 86_400_000);
  assert.equal(parseIntervalText("90s"), 90_000);
});

test("parseIntervalText 低于下限报错而不是 clamp", () => {
  assert.throws(
    () => parseIntervalText("45s"),
    (error: unknown) => error instanceof ScheduleTriggerError && /60/u.test(error.message),
  );
  assert.equal(SCHEDULER_LIMITS.minIntervalMs, 60_000);
});

test("parseIntervalText 高于上限报错，schema 同样拒绝超出安全整数的 everyMs", () => {
  assert.equal(parseIntervalText("365d"), SCHEDULER_LIMITS.maxIntervalMs);
  assert.throws(
    () => parseIntervalText("366d"),
    (error: unknown) => error instanceof ScheduleTriggerError && /365/u.test(error.message),
  );
  assert.throws(() => parseIntervalText("999999999d"), ScheduleTriggerError);
  assert.throws(
    () => parseTriggerJson('{"kind":"interval","everyMs":86400000000000000}'),
    ScheduleTriggerError,
  );
  assert.ok(Number.isSafeInteger(Date.now() + SCHEDULER_LIMITS.maxIntervalMs));
});

test("parseIntervalText 拒绝无法识别的格式", () => {
  for (const text of ["", "abc", "0m", "2H", "1.5h", "10"]) {
    assert.throws(() => parseIntervalText(text), ScheduleTriggerError);
  }
});

test("formatInterval 输出人类可读的中文周期", () => {
  assert.equal(formatInterval(1_800_000), "每 30 分钟");
  assert.equal(formatInterval(7_200_000), "每 2 小时");
  assert.equal(formatInterval(86_400_000), "每 1 天");
  assert.equal(formatInterval(90_000), "每 90 秒");
});

test("computeNextRunAtMs 从 now 重锚，不补课", () => {
  const trigger = createIntervalTrigger("5m");
  assert.deepEqual(trigger, { kind: "interval", everyMs: 300_000 });
  assert.equal(computeNextRunAtMs(trigger, 1_000_000), 1_300_000);
  assert.equal(describeTrigger(trigger), "每 5 分钟");
});

test("parseTriggerJson 拒绝未知 kind 与低于下限的 everyMs", () => {
  assert.deepEqual(parseTriggerJson('{"kind":"interval","everyMs":60000}'), {
    kind: "interval",
    everyMs: 60_000,
  });
  assert.throws(() => parseTriggerJson('{"kind":"daily","hour":9}'), ScheduleTriggerError);
  assert.throws(() => parseTriggerJson('{"kind":"interval","everyMs":1000}'), ScheduleTriggerError);
  assert.throws(() => parseTriggerJson("not json"), ScheduleTriggerError);
});
