import { test } from "node:test";
import assert from "node:assert/strict";
import { endsInsideThink, parseThinking } from "./thinking-text.ts";

test("parseThinking splits closed think blocks", () => {
  assert.deepEqual(parseThinking("前言<think>内部推理</think>答案"), [
    { text: "前言", thinking: false },
    { text: "内部推理", thinking: true },
    { text: "答案", thinking: false },
  ]);
});

test("parseThinking treats an unclosed think as thinking to end", () => {
  assert.deepEqual(parseThinking("答案<think>还在想"), [
    { text: "答案", thinking: false },
    { text: "还在想", thinking: true },
  ]);
});

test("parseThinking returns plain text as one non-thinking segment", () => {
  assert.deepEqual(parseThinking("纯文本"), [{ text: "纯文本", thinking: false }]);
});

test("parseThinking drops empty segments and strips tags", () => {
  assert.deepEqual(parseThinking("<think>x</think>"), [{ text: "x", thinking: true }]);
});

test("parseThinking treats text before a bare closing tag as thinking", () => {
  assert.deepEqual(parseThinking("推理续篇</think>可见回复"), [
    { text: "推理续篇", thinking: true },
    { text: "可见回复", thinking: false },
  ]);
  assert.deepEqual(parseThinking("</think>可见回复"), [{ text: "可见回复", thinking: false }]);
});

test("endsInsideThink tracks tag parity across a segment", () => {
  assert.equal(endsInsideThink("文字<think>开想", false), true);
  assert.equal(endsInsideThink("还在想", true), true);
  assert.equal(endsInsideThink("收尾</think>答案", true), false);
  assert.equal(endsInsideThink("<think>a</think>b", false), false);
  assert.equal(endsInsideThink("纯文本", false), false);
});
