import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionPickerItems,
  formatRelativeTime,
  type SessionPickerThread,
} from "./session-picker-format.ts";

const NOW = new Date("2026-08-05T12:00:00.000Z");

test("formatRelativeTime renders human-friendly buckets", () => {
  assert.equal(formatRelativeTime("2026-08-05T11:59:30.000Z", NOW), "刚刚");
  assert.equal(formatRelativeTime("2026-08-05T11:15:00.000Z", NOW), "45 分钟前");
  assert.equal(formatRelativeTime("2026-08-05T07:00:00.000Z", NOW), "5 小时前");
  assert.equal(formatRelativeTime("2026-08-02T12:00:00.000Z", NOW), "3 天前");
  assert.equal(formatRelativeTime("2026-06-01T12:00:00.000Z", NOW), "2026-06-01");
  assert.equal(formatRelativeTime("2026-08-05T12:00:30.000Z", NOW), "刚刚");
  assert.equal(formatRelativeTime("not-a-date", NOW), "");
});

test("buildSessionPickerItems excludes current session and falls back title", () => {
  const threads: SessionPickerThread[] = [
    { id: "current", title: "当前", updatedAt: "2026-08-05T11:00:00.000Z" },
    { id: "t1", title: "发布计划", updatedAt: "2026-08-05T10:00:00.000Z" },
    { id: "t2", title: undefined, updatedAt: "2026-08-04T12:00:00.000Z" },
  ];
  const counts: Record<string, number> = { t1: 12, t2: 3 };
  const items = buildSessionPickerItems(threads, {
    currentSessionId: "current",
    countMessages: (threadId) => counts[threadId] ?? 0,
    now: NOW,
  });
  assert.deepEqual(items, [
    { id: "t1", title: "发布计划", meta: "2 小时前 · 12 条消息" },
    { id: "t2", title: "（无标题）", meta: "1 天前 · 3 条消息" },
  ]);
});

test("buildSessionPickerItems omits empty relative time from meta", () => {
  const items = buildSessionPickerItems([{ id: "t1", title: "a", updatedAt: "bad" }], {
    currentSessionId: "x",
    countMessages: () => 1,
    now: NOW,
  });
  const first = items[0];
  assert.ok(first);
  assert.equal(first.meta, "1 条消息");
});
