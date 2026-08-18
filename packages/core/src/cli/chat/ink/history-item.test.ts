import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { HistoryItemView } from "./history-item.ts";
import type { HistoryItem } from "./state.ts";
import type { ChatThinkingDisplay } from "../../../config/schema.ts";

const REASONING_BODY = "先检查输入状态，再定位工具调用边界。";

function renderFrame(item: HistoryItem, thinkingDisplay?: ChatThinkingDisplay): string {
  const { lastFrame, unmount } = render(
    h(HistoryItemView, {
      item,
      ...(thinkingDisplay !== undefined ? { thinkingDisplay } : {}),
    }),
  );
  try {
    return stripVTControlCharacters(lastFrame() ?? "");
  } finally {
    unmount();
  }
}

test("reasoning items collapse to a one-line trace by default", () => {
  const frame = renderFrame({
    kind: "reasoning",
    id: "r1",
    text: REASONING_BODY,
    durationMs: 9_000,
  });
  assert.match(frame, /推理过程 · 9 秒 · \d+ 字 · 已折叠/);
  assert.doesNotMatch(frame, /先检查输入状态/);
});

test("reasoning items render in full when thinking display is expanded", () => {
  const frame = renderFrame(
    { kind: "reasoning", id: "r1", text: REASONING_BODY, durationMs: 9_000 },
    "expanded",
  );
  assert.match(frame, /推理过程/);
  assert.match(frame, /先检查输入状态/);
  assert.doesNotMatch(frame, /已折叠/);
});

test("assistant inline think segments collapse in committed history by default", () => {
  const frame = renderFrame({
    kind: "assistant",
    id: "a1",
    text: "<think>内部推理过程</think>最终答案",
  });
  assert.match(frame, /最终答案/);
  assert.match(frame, /已折叠/);
  assert.doesNotMatch(frame, /内部推理过程/);
});

test("assistant inline think segments stay visible when display is expanded", () => {
  const frame = renderFrame(
    { kind: "assistant", id: "a1", text: "<think>内部推理过程</think>最终答案" },
    "expanded",
  );
  assert.match(frame, /最终答案/);
  assert.match(frame, /内部推理过程/);
  assert.doesNotMatch(frame, /已折叠/);
});

test("whitespace-only inline think segments render no collapsed trace", () => {
  const frame = renderFrame({
    kind: "assistant",
    id: "a1",
    text: "<think>  \n\t </think>最终答案",
  });
  assert.match(frame, /最终答案/);
  assert.doesNotMatch(frame, /推理过程/);
  assert.doesNotMatch(frame, /已折叠/);
});
