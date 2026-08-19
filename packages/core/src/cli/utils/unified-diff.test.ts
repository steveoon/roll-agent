import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { formatDiffHeader, formatFileChangeDiffLines, parseUnifiedDiff } from "./unified-diff.ts";

const UNIFIED = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,4 +3,4 @@",
  " line 3",
  "-line 4",
  "+line four",
  " line 5",
  "@@ -10,1 +10,2 @@",
  " x",
  "+y",
  "\\ No newline at end of file",
  "",
].join("\n");

const DIFF: FileChangeDiff = {
  path: "src/a.ts",
  change: "modify",
  added: 2,
  removed: 1,
  hunks: 2,
  unified: UNIFIED,
  truncated: false,
};

test("parseUnifiedDiff 标注类型并跟踪新旧行号", () => {
  const lines = parseUnifiedDiff(UNIFIED);
  assert.deepEqual(
    lines.slice(0, 2).map((l) => l.kind),
    ["meta", "meta"],
  );
  assert.deepEqual(lines[2], { kind: "hunk", text: "@@ -3,4 +3,4 @@" });
  assert.deepEqual(lines[3], { kind: "context", text: "line 3", oldLine: 3, newLine: 3 });
  assert.deepEqual(lines[4], { kind: "del", text: "line 4", oldLine: 4 });
  assert.deepEqual(lines[5], { kind: "add", text: "line four", newLine: 4 });
  assert.deepEqual(lines[6], { kind: "context", text: "line 5", oldLine: 5, newLine: 5 });
  assert.deepEqual(lines[8], { kind: "context", text: "x", oldLine: 10, newLine: 10 });
  assert.deepEqual(lines[9], { kind: "add", text: "y", newLine: 11 });
  assert.deepEqual(lines[10], { kind: "note", text: "\\ No newline at end of file" });
});

test("parseUnifiedDiff 只在首个 hunk 之前把 ---/+++ 当文件头", () => {
  const lines = parseUnifiedDiff(
    "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n--- not meta\n+++ also not meta\n",
  );
  assert.deepEqual(
    lines.slice(3).map((l) => l.kind),
    ["del", "add"],
  );
  assert.equal(lines[3]?.text, "-- not meta");
});

test("formatDiffHeader 含路径、统计与状态标签", () => {
  assert.equal(formatDiffHeader(DIFF), "src/a.ts  +2 −1");
  assert.equal(formatDiffHeader({ ...DIFF, change: "create" }), "src/a.ts  +2 −1  新建");
  assert.equal(formatDiffHeader({ ...DIFF, truncated: true }), "src/a.ts  +2 −1  已截断");
  const { unified: _u, ...statsOnly } = DIFF;
  assert.equal(formatDiffHeader(statsOnly), "src/a.ts  +2 −1  正文省略（文件过大）");
});

test("formatFileChangeDiffLines 无色模式输出行号栏与前缀，超过上限时折叠并给提示", () => {
  const lines = formatFileChangeDiffLines(DIFF, { color: false });
  assert.equal(lines[0], "src/a.ts  +2 −1");
  assert.ok(lines.some((l) => /^\s*4\s+-\s?line 4$/u.test(l) || l.includes("- line 4")));
  const collapsed = formatFileChangeDiffLines(DIFF, {
    color: false,
    maxBodyLines: 2,
    collapsedHint: "/diff on 展开",
  });
  assert.equal(collapsed.length, 4);
  assert.match(collapsed[3] ?? "", /另 \d+ 行/u);
  assert.match(collapsed[3] ?? "", /\/diff on 展开/u);
});

test("formatFileChangeDiffLines 着色模式剥掉 ANSI 后与无色一致，且控制字符被清洗", () => {
  const dirty: FileChangeDiff = {
    ...DIFF,
    unified: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\x1b[31mb\n+ok\n",
  };
  const colored = formatFileChangeDiffLines(dirty, { color: true }).map((l) =>
    stripVTControlCharacters(l),
  );
  const plain = formatFileChangeDiffLines(dirty, { color: false });
  assert.deepEqual(colored, plain);
  assert.ok(plain.every((l) => !l.includes("\x1b")));
});
