import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import {
  countReasoningChars,
  formatReasoningDuration,
  formatReasoningSummary,
  ReasoningBlock,
  ReasoningSummary,
} from "./reasoning-block.ts";

test("formatReasoningDuration renders sub-second thinking as under one second", () => {
  assert.equal(formatReasoningDuration(0), "不到 1 秒");
  assert.equal(formatReasoningDuration(499), "不到 1 秒");
  assert.equal(formatReasoningDuration(1_200), "1 秒");
  assert.equal(formatReasoningDuration(34_000), "34 秒");
});

test("countReasoningChars ignores whitespace so the trace reflects content size", () => {
  assert.equal(countReasoningChars("先想 一步\n再想一步"), 8);
  assert.equal(countReasoningChars(""), 0);
});

test("formatReasoningSummary keeps a short single-line trace with duration and size", () => {
  assert.equal(formatReasoningSummary("先想一步", 8_000), "推理过程 · 8 秒 · 4 字 · 已折叠");
  assert.equal(formatReasoningSummary("先想一步"), "推理过程 · 4 字 · 已折叠");
});

test("ReasoningBlock renders the full reasoning text", () => {
  const { lastFrame, unmount } = render(h(ReasoningBlock, { text: "第一步\n第二步" }));
  const frame = stripVTControlCharacters(lastFrame() ?? "");
  assert.match(frame, /推理过程/);
  assert.match(frame, /第一步/);
  assert.match(frame, /第二步/);
  assert.doesNotMatch(frame, /已折叠/);
  unmount();
});

test("ReasoningSummary leaves a duration/size trace without the reasoning body", () => {
  const body = "先检查输入状态，再定位工具调用边界。";
  const { lastFrame, unmount } = render(h(ReasoningSummary, { text: body, durationMs: 12_000 }));
  const frame = stripVTControlCharacters(lastFrame() ?? "");
  assert.match(frame, /推理过程 · 12 秒 · \d+ 字 · 已折叠/);
  assert.doesNotMatch(frame, /先检查输入状态/);
  unmount();
});

test("ReasoningSummary omits the duration segment when it is unknown", () => {
  const { lastFrame, unmount } = render(h(ReasoningSummary, { text: "内部推理" }));
  const frame = stripVTControlCharacters(lastFrame() ?? "");
  assert.match(frame, /推理过程 · 4 字 · 已折叠/);
  assert.doesNotMatch(frame, /秒/);
  unmount();
});
