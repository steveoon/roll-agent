import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { FileChangeDiff } from "@roll-agent/runtime";
import {
  diffBodyLines,
  formatDiffGutter,
  formatDiffHeader,
  formatFileChangeDiffLines,
  gutterNumber,
  parseUnifiedDiff,
  type DiffLine,
} from "./unified-diff.ts";

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
  assert.ok(lines.some((l) => l === " 4 - line 4"));
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

test("diffBodyLines 去掉文件头与首个 hunk 头，后续 hunk 头保留为分隔行", () => {
  const lines = diffBodyLines(DIFF);
  assert.equal(lines[0]?.kind, "context");
  assert.equal(lines[0]?.text, "line 3");
  const hunkLines = lines.filter((line) => line.kind === "hunk");
  assert.equal(hunkLines.length, 1);
  assert.equal(lines.filter((line) => line.kind === "meta").length, 0);
});

test("gutterNumber：上下文与新增行取新行号，删除行取旧行号", () => {
  const lines = diffBodyLines(DIFF);
  const context = lines.find((line) => line.kind === "context");
  const del = lines.find((line) => line.kind === "del");
  const add = lines.find((line) => line.kind === "add");
  assert.equal(gutterNumber(context as DiffLine), 3);
  assert.equal(gutterNumber(del as DiffLine), 4);
  assert.equal(gutterNumber(add as DiffLine), 4);
  assert.equal(formatDiffGutter(del as DiffLine, 3), "  4 - ");
  assert.equal(formatDiffGutter(add as DiffLine, 3), "  4 + ");
  assert.equal(formatDiffGutter(context as DiffLine, 3), "  3   ");
  assert.equal(formatDiffGutter({ kind: "hunk", text: "@@ -9 +9 @@" }, 3), "  ⋯   ");
  assert.equal(formatDiffGutter({ kind: "note", text: "\\ No newline" }, 3), "      ");
});

test("annotateIntralineChanges 为配对的删除/新增行标出 token 级差异片段", () => {
  const unified = [
    "--- a/f",
    "+++ b/f",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-edit_file预览续行对齐测试packages/runtime 旧值 alpha",
    "+edit_file预览续行对齐测试OKpackages/runtime 新值 alpha",
    "@@ -9,1 +9,1 @@",
    "-完全不同的一行内容 aaa bbb ccc",
    "+xyz 123 456",
    "",
  ].join("\n");
  const lines = diffBodyLines({ ...DIFF, unified });
  const del = lines[1];
  const add = lines[2];
  assert.ok(del?.kind === "del" && add?.kind === "add");
  assert.deepEqual(
    del.segments?.filter((segment) => segment.changed).map((segment) => segment.text),
    ["旧"],
  );
  assert.deepEqual(
    add.segments?.filter((segment) => segment.changed).map((segment) => segment.text),
    ["OK", "新"],
  );
  assert.equal(del.segments?.map((segment) => segment.text).join(""), del.text);
  assert.equal(add.segments?.map((segment) => segment.text).join(""), add.text);
  const farDel = lines.find((line) => line.kind === "del" && line.text.startsWith("完全"));
  const farAdd = lines.find((line) => line.kind === "add" && line.text.startsWith("xyz"));
  assert.equal(farDel?.segments, undefined);
  assert.equal(farAdd?.segments, undefined);
});

test("annotateIntralineChanges 对公共字符过少的改动 token 不做字符级细化", () => {
  const lines = diffBodyLines({
    ...DIFF,
    unified: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-对齐测试OKpackages\n+对齐测试DONEpackages\n",
  });
  const del = lines[0];
  const add = lines[1];
  assert.ok(del?.kind === "del" && add?.kind === "add");
  assert.deepEqual(
    del.segments?.filter((segment) => segment.changed).map((segment) => segment.text),
    ["OK"],
  );
  assert.deepEqual(
    add.segments?.filter((segment) => segment.changed).map((segment) => segment.text),
    ["DONE"],
  );
});

test("formatFileChangeDiffLines 使用单列行号、不输出 @@ 头、多 hunk 之间用 ⋯ 分隔，改动片段反色", () => {
  const lines = formatFileChangeDiffLines(DIFF, { color: false });
  assert.equal(lines[0], "src/a.ts  +2 −1");
  assert.equal(lines[1], " 3   line 3");
  assert.equal(lines[2], " 4 - line 4");
  assert.equal(lines[3], " 4 + line four");
  assert.equal(lines[4], " 5   line 5");
  assert.equal(lines[5], " ⋯   ");
  assert.equal(lines[6], "10   x");
  assert.equal(lines[7], "11 + y");
  assert.ok(lines.every((line) => !line.includes("@@")));
  const colored = formatFileChangeDiffLines(
    {
      ...DIFF,
      unified: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-foo bar\n+foo baz\n",
    },
    { color: true },
  );
  assert.deepEqual(
    colored.map((line) => stripVTControlCharacters(line)),
    ["src/a.ts  +2 −1", "1 - foo bar", "1 + foo baz"],
  );
});
