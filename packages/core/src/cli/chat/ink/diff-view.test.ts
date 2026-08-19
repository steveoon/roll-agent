import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { DiffBlock, DiffSummary, diffBodyLineCount } from "./diff-view.ts";

const DIFF: FileChangeDiff = {
  path: "src/a.ts",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
  truncated: false,
};

function frame(element: ReturnType<typeof h>): string {
  const { lastFrame, unmount } = render(element);
  try {
    return stripVTControlCharacters(lastFrame() ?? "");
  } finally {
    unmount();
  }
}

test("DiffBlock 渲染头行、hunk 头、行号栏与增删前缀", () => {
  const out = frame(h(DiffBlock, { diff: DIFF }));
  assert.match(out, /src\/a\.ts\s+\+1 −1/u);
  assert.match(out, /1 {3}a/u);
  assert.match(out, /2 - b/u);
  assert.match(out, /2 \+ B/u);
  assert.doesNotMatch(out, /@@/u);
  assert.equal(diffBodyLineCount(DIFF), 4);
});

test("DiffBlock 超过 maxBodyLines 时截断并提示剩余行数", () => {
  const out = frame(h(DiffBlock, { diff: DIFF, maxBodyLines: 2, collapsedHint: "/diff on 展开" }));
  assert.match(out, /另 2 行（\/diff on 展开）/u);
  assert.doesNotMatch(out, /\+ B/u);
});

test("DiffSummary 折叠为一行并带提示；正文省略时显示原因", () => {
  const out = frame(h(DiffSummary, { diff: DIFF, hint: "/diff 展开" }));
  assert.equal(out.split("\n").length, 1);
  assert.match(out, /src\/a\.ts\s+\+1 −1 · 已折叠 · \/diff 展开/u);
  const { unified: _u, ...statsOnly } = DIFF;
  assert.match(frame(h(DiffSummary, { diff: statsOnly })), /正文省略（文件过大）/u);
});

test("DiffBlock 长行换行后的续行与正文列对齐，不顶到边框", () => {
  const longLine = "x".repeat(70);
  const diff: FileChangeDiff = {
    path: "f",
    change: "modify",
    added: 1,
    removed: 0,
    hunks: 1,
    unified: `--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n a\n+${longLine}\n`,
    truncated: false,
  };
  const out = frame(h(Box, { width: 40 }, h(DiffBlock, { diff })));
  const lines = out.split("\n");
  const first = lines.find((line) => line.includes("+ xxxx"));
  const continuation = lines.find((line) => /^│\s+x+$/u.test(line));
  assert.ok(first !== undefined && continuation !== undefined);
  const contentColumn = first.indexOf("+");
  const continuationColumn = continuation.search(/x/u);
  assert.equal(continuationColumn, contentColumn + 2);
});
