import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
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
  assert.match(out, /@@ -1,3 \+1,3 @@/u);
  assert.match(out, /1\s+1\s+ a/u);
  assert.match(out, /2\s+-b/u);
  assert.match(out, /2\s+\+B/u);
  assert.equal(diffBodyLineCount(DIFF), 5);
});

test("DiffBlock 超过 maxBodyLines 时截断并提示剩余行数", () => {
  const out = frame(h(DiffBlock, { diff: DIFF, maxBodyLines: 2, collapsedHint: "/diff on 展开" }));
  assert.match(out, /另 3 行（\/diff on 展开）/u);
  assert.doesNotMatch(out, /\+B/u);
});

test("DiffSummary 折叠为一行并带提示；正文省略时显示原因", () => {
  const out = frame(h(DiffSummary, { diff: DIFF, hint: "/diff 展开" }));
  assert.equal(out.split("\n").length, 1);
  assert.match(out, /src\/a\.ts\s+\+1 −1 · 已折叠 · \/diff 展开/u);
  const { unified: _u, ...statsOnly } = DIFF;
  assert.match(frame(h(DiffSummary, { diff: statsOnly })), /正文省略（文件过大）/u);
});
