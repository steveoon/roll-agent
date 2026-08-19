import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { HistoryItemView } from "./history-item.ts";
import type { HistoryItem } from "./state.ts";
import type { ChatThinkingDisplay } from "../../../config/schema.ts";
import type { DiffDisplayMode } from "../diff-display.ts";

const REASONING_BODY = "先检查输入状态，再定位工具调用边界。";

function renderFrame(
  item: HistoryItem,
  thinkingDisplay?: ChatThinkingDisplay,
  diffDisplay?: DiffDisplayMode,
): string {
  const { lastFrame, unmount } = render(
    h(HistoryItemView, {
      item,
      ...(thinkingDisplay !== undefined ? { thinkingDisplay } : {}),
      ...(diffDisplay !== undefined ? { diffDisplay } : {}),
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

const ITEM_DIFF = {
  path: "src/a.ts",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-b\n+B\n",
  truncated: false,
} as const;

test("带 diff 的 tool 项在工具行下展开小 diff", () => {
  const frame = renderFrame({
    kind: "tool",
    id: "t1",
    name: "roll.edit_file",
    args: '{"file_path":"src/a.ts"}',
    ok: true,
    diff: ITEM_DIFF,
  });
  assert.match(frame, /✓ roll\.edit_file/u);
  assert.match(frame, /src\/a\.ts\s+\+1 −1/u);
  assert.match(frame, /-b/u);
  assert.match(frame, /\+B/u);
});

test("超过阈值的 diff 在 collapsed 模式折叠为一行摘要，expanded 模式完整显示", () => {
  const body = Array.from({ length: 50 }, (_, i) => `+L${String(i)}`).join("\n");
  const big = {
    ...ITEM_DIFF,
    added: 50,
    removed: 0,
    unified: `--- a/f\n+++ b/f\n@@ -0,0 +1,50 @@\n${body}\n`,
  };
  const collapsed = renderFrame({
    kind: "tool",
    id: "t2",
    name: "roll.write_file",
    args: "",
    ok: true,
    diff: big,
  });
  assert.match(collapsed, /已折叠 · \/diff 展开/u);
  assert.doesNotMatch(collapsed, /\+L49/u);
  const expanded = renderFrame(
    { kind: "tool", id: "t2", name: "roll.write_file", args: "", ok: true, diff: big },
    undefined,
    "expanded",
  );
  assert.match(expanded, /\+L49/u);
});

test("tool 行的 args 在窄终端里单行截断，不整体掉到下一行", () => {
  const { lastFrame, unmount } = render(
    h(
      Box,
      { width: 40 },
      h(HistoryItemView, {
        item: {
          kind: "tool",
          id: "t-narrow",
          name: "roll.write_file",
          args: '{"file_path":"/Users/someone/very/long/path/to/a/file.txt","content":"…"}',
          ok: true,
        },
      }),
    ),
  );
  try {
    const out = stripVTControlCharacters(lastFrame() ?? "");
    const lines = out.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^✓ roll\.write_file \{"file_path".*…$/u);
  } finally {
    unmount();
  }
});
