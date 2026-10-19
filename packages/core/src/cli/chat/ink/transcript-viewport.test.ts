import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  computeVisibleWindow,
  coalesceScrollOffset,
  retainedScrollOffset,
  TranscriptViewport,
} from "./transcript-viewport.ts";
import { createElement as h } from "react";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import { setTimeout as delay } from "node:timers/promises";
import { createInitialState, type HistoryItem } from "./state.ts";

afterEach(() => cleanup());

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

test("prepending preserves the reading anchor while appended output stays below it", () => {
  assert.equal(retainedScrollOffset(20, 50, 0, 50, 100), 20);
  assert.equal(retainedScrollOffset(20, 57, 0, 50, 100), 27);
  assert.equal(retainedScrollOffset(20, 0, 3, 0, 100), 17);
});

test("viewport loads older records with PageUp and preserves visible rows after prepend", async () => {
  let loads = 0;
  const original: HistoryItem[] = Array.from({ length: 20 }, (_, i) => ({
    kind: "user",
    id: `row-${i}`,
    text: `row-${i}`,
  }));
  const viewFor = (history: readonly HistoryItem[]) =>
    h(
      Box,
      { height: 8, width: 60 },
      h(TranscriptViewport, {
        width: 60,
        history,
        live: createInitialState("test", undefined).live,
        animateBanner: false,
        onBannerSettled: () => {},
        navigationBlocked: false,
        thinkingDisplay: "collapsed",
        diffDisplay: "collapsed",
        historyNotice: "↑ 还有更早记录，向上滚动加载",
        onLoadOlder: () => {
          loads++;
        },
      }),
    );
  const view = render(viewFor(original));
  // Layout measurement and scroll coalescing need not settle within a fixed key count on CI.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    view.stdin.write("\u001b[5~");
    await delay(25);
    if (loads > 0 && /row-0\b/.test(view.lastFrame() ?? "")) break;
  }
  assert.ok(loads > 0);
  assert.match(view.lastFrame() ?? "", /row-0\b/);
  const before = (view.lastFrame() ?? "").match(/row-\d+/g);
  assert.ok(before?.length);
  view.rerender(
    viewFor([
      ...Array.from(
        { length: 10 },
        (_, i): HistoryItem => ({ kind: "user", id: `earlier-${i}`, text: `earlier-${i}` }),
      ),
      ...original,
    ]),
  );
  await delay(100);
  const after = view.lastFrame() ?? "";
  assert.deepEqual(after.match(/row-\d+/g), before);
  assert.doesNotMatch(after, /条新内容/);
});
