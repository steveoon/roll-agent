import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupContextWindow, resolveContextWindow } from "./context-window.ts";

test("lookupContextWindow 按子串匹配已知模型", () => {
  assert.equal(lookupContextWindow("claude-sonnet-4-6"), 200_000);
  assert.equal(lookupContextWindow("gpt-4o-mini"), 128_000);
  assert.equal(lookupContextWindow("deepseek-v4-flash"), 128_000);
  assert.equal(lookupContextWindow("qwen3.6-plus"), 131_072);
});

test("lookupContextWindow 未知模型返回 undefined", () => {
  assert.equal(lookupContextWindow("some-private-llm"), undefined);
});

test("resolveContextWindow override 永远优先于内置表", () => {
  assert.equal(resolveContextWindow("claude-sonnet-4-6", 8_000), 8_000);
  assert.equal(resolveContextWindow("some-private-llm", 32_000), 32_000);
});

test("resolveContextWindow 无 override 时回落内置表", () => {
  assert.equal(resolveContextWindow("claude-sonnet-4-6"), 200_000);
  assert.equal(resolveContextWindow("some-private-llm"), undefined);
});
