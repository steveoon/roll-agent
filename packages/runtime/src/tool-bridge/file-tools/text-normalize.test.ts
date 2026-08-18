import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForMatch } from "./text-normalize.ts";

test("CRLF 折叠为 LF 且映射指回原文", () => {
  const result = normalizeForMatch("a\r\nb");
  assert.equal(result.text, "a\nb");
  assert.deepEqual(result.map, [0, 2, 3]);
});

test("全角标点与智能引号折叠为半角", () => {
  const result = normalizeForMatch("你好，\u{201C}世界\u{201D}！");
  assert.equal(result.text, '你好,"世界"!');
});

test("全角空格与 NBSP 折叠为半角空格", () => {
  assert.equal(normalizeForMatch("a　b\u{00A0}c").text, "a b c");
});

test("破折号族折叠为连字符", () => {
  assert.equal(normalizeForMatch("a—b–c―d").text, "a-b-c-d");
});

test("顿号与省略号保持原样", () => {
  assert.equal(normalizeForMatch("甲、乙…").text, "甲、乙…");
});

test("代理对字符原样保留且映射逐单元对应", () => {
  const result = normalizeForMatch("\u{1F600}");
  assert.equal(result.text, "\u{1F600}");
  assert.deepEqual(result.map, [0, 1]);
});

test("映射能将归一化命中切回原文区间", () => {
  const original = "前缀\u{201C}内容\u{201D}后缀";
  const { text, map } = normalizeForMatch(original);
  const needle = '"内容"';
  const start = text.indexOf(needle);
  const origStart = map[start];
  const lastMapped = map[start + needle.length - 1];
  assert.ok(origStart !== undefined && lastMapped !== undefined);
  assert.equal(original.slice(origStart, lastMapped + 1), "\u{201C}内容\u{201D}");
});
