import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupContextWindow, resolveContextWindow } from "./context-window.ts";

test("lookupContextWindow 按子串匹配已知模型", () => {
  assert.equal(lookupContextWindow("claude-sonnet-5"), 1_000_000);
  assert.equal(lookupContextWindow("claude-sonnet-4-6"), 1_000_000);
  assert.equal(lookupContextWindow("claude-opus-4-7"), 1_000_000);
  assert.equal(lookupContextWindow("claude-opus-4-6"), 1_000_000);
  assert.equal(lookupContextWindow("claude-fable-5"), 1_000_000);
  assert.equal(lookupContextWindow("claude-haiku-4-5"), 200_000);
  assert.equal(lookupContextWindow("claude-3-haiku-20240307"), 200_000);
  assert.equal(lookupContextWindow("gpt-5.5"), 1_050_000);
  assert.equal(lookupContextWindow("gpt-5.4-mini"), 400_000);
  assert.equal(lookupContextWindow("gpt-5"), 400_000);
  assert.equal(lookupContextWindow("gpt-4o-mini"), 128_000);
  assert.equal(lookupContextWindow("o1-mini"), 128_000);
  assert.equal(lookupContextWindow("o3"), 200_000);
  assert.equal(lookupContextWindow("grok-4.5"), 500_000);
  assert.equal(lookupContextWindow("xai/grok-4.5"), 500_000);
  assert.equal(lookupContextWindow("deepseek-v4-flash"), 1_000_000);
  assert.equal(lookupContextWindow("deepseek-chat"), 1_000_000);
  assert.equal(lookupContextWindow("deepseek-v3.1"), 128_000);
  assert.equal(lookupContextWindow("qwen3.8-max"), 1_000_000);
  assert.equal(lookupContextWindow("qwen3.8-plus"), 1_000_000);
  assert.equal(lookupContextWindow("qwen3.7-plus"), 1_000_000);
  assert.equal(lookupContextWindow("qwen3.7-max"), 1_000_000);
  assert.equal(lookupContextWindow("qwen3.6-plus"), 1_000_000);
  assert.equal(lookupContextWindow("qwen-long-latest"), 10_000_000);
  assert.equal(lookupContextWindow("qwen3-max"), 262_144);
});

test("lookupContextWindow 未知模型返回 undefined", () => {
  assert.equal(lookupContextWindow("some-private-llm"), undefined);
});

test("resolveContextWindow override 永远优先于内置表", () => {
  assert.equal(resolveContextWindow("claude-sonnet-4-6", 8_000), 8_000);
  assert.equal(resolveContextWindow("some-private-llm", 32_000), 32_000);
});

test("resolveContextWindow 无 override 时回落内置表", () => {
  assert.equal(resolveContextWindow("claude-sonnet-4-6"), 1_000_000);
  assert.equal(resolveContextWindow("some-private-llm"), undefined);
});
