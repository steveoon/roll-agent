import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_FRESHNESS, FileStateTracker } from "./file-state-tracker.ts";

test("未记录的文件返回 unread", () => {
  const tracker = new FileStateTracker();
  assert.equal(tracker.checkFreshness("/a", "content"), FILE_FRESHNESS.unread);
});

test("记录后内容一致返回 fresh、不一致返回 stale", () => {
  const tracker = new FileStateTracker();
  tracker.recordKnownContent("/a", "v1");
  assert.equal(tracker.checkFreshness("/a", "v1"), FILE_FRESHNESS.fresh);
  assert.equal(tracker.checkFreshness("/a", "v2"), FILE_FRESHNESS.stale);
});

test("重新记录覆盖旧状态", () => {
  const tracker = new FileStateTracker();
  tracker.recordKnownContent("/a", "v1");
  tracker.recordKnownContent("/a", "v2");
  assert.equal(tracker.checkFreshness("/a", "v2"), FILE_FRESHNESS.fresh);
});

test("超过容量上限时最早记录被淘汰", () => {
  const tracker = new FileStateTracker();
  for (let index = 0; index < 513; index += 1) {
    tracker.recordKnownContent(`/f${String(index)}`, "v");
  }
  assert.equal(tracker.checkFreshness("/f0", "v"), FILE_FRESHNESS.unread);
  assert.equal(tracker.checkFreshness("/f512", "v"), FILE_FRESHNESS.fresh);
});
