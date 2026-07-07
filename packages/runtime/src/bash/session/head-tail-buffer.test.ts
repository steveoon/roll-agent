import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadTailBuffer } from "./head-tail-buffer.ts";

test("未超容量时 drain 全量返回，omitted 0", () => {
  const buffer = new HeadTailBuffer(1_000);
  buffer.append("hello ");
  buffer.append("world");
  const result = buffer.drain(1_000);
  assert.equal(result.text, "hello world");
  assert.equal(result.omitted, 0);
});

test("单次 drain 超 maxChars 时保头尾、带截断标记并计 omitted", () => {
  const buffer = new HeadTailBuffer(1_000);
  buffer.append(`START${"a".repeat(100)}END`);
  const result = buffer.drain(10);
  assert.ok(result.text.startsWith("START"));
  assert.ok(result.text.endsWith("END"));
  assert.ok(result.text.includes("chars truncated"));
  assert.equal(result.omitted, 98);
});

test("append 超 capacity 时保窗口头尾，丢中间并累计 omitted", () => {
  const buffer = new HeadTailBuffer(10);
  buffer.append("1234567890");
  buffer.append("ABCDE");
  const result = buffer.drain(100);
  assert.ok(result.text.startsWith("12345"), "窗口开头必须保留");
  assert.ok(result.text.endsWith("ABCDE"), "窗口末尾必须保留");
  assert.ok(result.text.includes("chars truncated"));
  assert.equal(result.omitted, 5);
});

test("drain 后清空，再次 drain 为空，head 在新窗口重新累积", () => {
  const buffer = new HeadTailBuffer(10);
  buffer.append("1234567890AB");
  buffer.drain(100);
  assert.equal(buffer.hasPending(), false);
  const again = buffer.drain(1_000);
  assert.equal(again.text, "");
  assert.equal(again.omitted, 0);
  buffer.append("fresh");
  const next = buffer.drain(1_000);
  assert.equal(next.text, "fresh");
});
