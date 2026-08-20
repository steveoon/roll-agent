import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVisibleWindow, coalesceScrollOffset } from "./transcript-viewport.ts";

test("computeVisibleWindow follows the tail and keeps one viewport of overscan", () => {
  const result = computeVisibleWindow([2, 2, 2, 2, 2, 2], 4, 0);
  assert.deepEqual(result, {
    startIndex: 2,
    endIndex: 6,
    topSpacer: 4,
    bottomSpacer: 0,
    totalHeight: 12,
  });
});

test("computeVisibleWindow moves toward the oldest entries without blank overscroll", () => {
  const result = computeVisibleWindow([2, 2, 2, 2, 2, 2], 4, 99);
  assert.deepEqual(result, {
    startIndex: 0,
    endIndex: 4,
    topSpacer: 0,
    bottomSpacer: 4,
    totalHeight: 12,
  });
});

test("coalesceScrollOffset keeps the latest offset inside the current range", () => {
  assert.equal(coalesceScrollOffset(4, 12), 4);
  assert.equal(coalesceScrollOffset(99, 12), 12);
  assert.equal(coalesceScrollOffset(-3, 12), 0);
});
