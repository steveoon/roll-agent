import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findAllExact,
  findOldString,
  formatMultiMatchDiagnosis,
  formatNoMatchDiagnosis,
  lineNumberAt,
  lineNumberPrefixWarning,
  renderNumberedLines,
} from "./match-pipeline.ts";

test("findAllExact 返回不重叠命中", () => {
  assert.deepEqual(findAllExact("aaa", "aa"), [{ start: 0, end: 2 }]);
  assert.deepEqual(findAllExact("ab ab", "ab"), [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
  ]);
});

test("精确唯一命中优先且不标记归一化", () => {
  const result = findOldString("hello world", "world");
  assert.equal(result.kind, "unique");
  if (result.kind === "unique") {
    assert.deepEqual(result.span, { start: 6, end: 11 });
    assert.equal(result.viaNormalization, false);
  }
});

test("精确失败后归一化唯一命中并切回原文区间", () => {
  const content = "标题：\u{201C}花卷\u{201D}正文";
  const result = findOldString(content, '标题:"花卷"');
  assert.equal(result.kind, "unique");
  if (result.kind === "unique") {
    assert.equal(content.slice(result.span.start, result.span.end), "标题：\u{201C}花卷\u{201D}");
    assert.equal(result.viaNormalization, true);
  }
});

test("CRLF 文件可用 LF old_string 命中且区间含 CR", () => {
  const content = "first\r\nsecond\r\n";
  const result = findOldString(content, "first\nsecond");
  assert.equal(result.kind, "unique");
  if (result.kind === "unique") {
    assert.equal(content.slice(result.span.start, result.span.end), "first\r\nsecond");
  }
});

test("多处命中返回 multiple", () => {
  const result = findOldString("x=1\nx=1\n", "x=1");
  assert.equal(result.kind, "multiple");
  if (result.kind === "multiple") {
    assert.equal(result.spans.length, 2);
  }
});

test("完全不命中返回 none", () => {
  assert.equal(findOldString("abc", "zzz").kind, "none");
});

test("renderNumberedLines 五位右对齐加箭头", () => {
  assert.equal(renderNumberedLines(["a", "b"], 9), "    9→a\n   10→b");
});

test("lineNumberAt 按换行计数", () => {
  assert.equal(lineNumberAt("a\nb\nc", 0), 1);
  assert.equal(lineNumberAt("a\nb\nc", 2), 2);
  assert.equal(lineNumberAt("a\nb\nc", 4), 3);
});

test("行号前缀警告识别误带前缀", () => {
  assert.ok(lineNumberPrefixWarning("   12→const x = 1") !== undefined);
  assert.equal(lineNumberPrefixWarning("const x = 1"), undefined);
});

test("no-match 诊断包含最近似行的上下文与差异描述", () => {
  const content = "第一行\n总部位于上海市\n第三行";
  const diagnosis = formatNoMatchDiagnosis(content, "总部位于上海");
  assert.match(diagnosis, /未在文件中找到匹配/u);
  assert.match(diagnosis, /第 2 行/u);
  assert.match(diagnosis, /总部位于上海市/u);
  assert.match(diagnosis, /重新 read_file/u);
});

test("multi-match 诊断列出各命中行并给出两条出路", () => {
  const content = "x=1\ny\nx=1\n";
  const diagnosis = formatMultiMatchDiagnosis(content, findAllExact(content, "x=1"));
  assert.match(diagnosis, /出现 2 次/u);
  assert.match(diagnosis, /第 1 行/u);
  assert.match(diagnosis, /第 3 行/u);
  assert.match(diagnosis, /replace_all/u);
});
