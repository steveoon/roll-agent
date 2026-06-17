import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolResult, readIsError } from "./normalize-result.ts";

test("normalizeToolResult 提取 text content", () => {
  const result = normalizeToolResult({ content: [{ type: "text", text: "hello" }] });
  assert.equal(result.output, "hello");
  assert.equal(result.isError, false);
});

test("normalizeToolResult 拼接多段 text", () => {
  const result = normalizeToolResult({
    content: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  });
  assert.equal(result.output, "a\nb");
});

test("normalizeToolResult 标记 isError", () => {
  const result = normalizeToolResult({
    isError: true,
    content: [{ type: "text", text: "boom" }],
  });
  assert.equal(result.output, "boom");
  assert.equal(result.isError, true);
});

test("normalizeToolResult 无 text 时回退原始", () => {
  const raw = { content: [{ type: "image", data: "x" }] };
  const result = normalizeToolResult(raw);
  assert.equal(result.output, raw);
  assert.equal(result.isError, false);
});

test("readIsError 判定", () => {
  assert.equal(readIsError({ isError: true }), true);
  assert.equal(readIsError({ output: "x", isError: false }), false);
  assert.equal(readIsError("x"), false);
  assert.equal(readIsError(null), false);
});
