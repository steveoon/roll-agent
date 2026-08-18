import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateMiddle } from "./truncate.ts";

test("预算内原样返回", () => {
  const result = truncateMiddle("hello", 10);
  assert.equal(result.text, "hello");
  assert.equal(result.truncated, false);
  assert.equal(result.removed, 0);
});

test("超预算保头尾并插入截断标记", () => {
  const result = truncateMiddle("0123456789", 4);
  assert.equal(result.truncated, true);
  assert.equal(result.removed, 6);
  assert.ok(result.text.startsWith("01"));
  assert.ok(result.text.endsWith("89"));
  assert.ok(result.text.includes("6 chars truncated"));
});

test("截断标记携带保留范围与全文长度，模型可定位丢失区间", () => {
  const result = truncateMiddle("0123456789", 4);
  assert.ok(result.text.includes("保留前 2 与后 2 字符"));
  assert.ok(result.text.includes("全文 10 字符"));
  assert.ok(result.text.includes("中段见落盘文件或重跑更窄的命令"));
});

test("maxChars 为 0 时全部截断", () => {
  const result = truncateMiddle("abc", 0);
  assert.equal(result.text, "");
  assert.equal(result.truncated, true);
  assert.equal(result.removed, 3);
});

test("不切碎多字节字符（emoji 按码点处理）", () => {
  const result = truncateMiddle("😀😁😂😃😄😅", 2);
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes("�"));
});
