import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeConfigSchema } from "../config/schema.ts";
import {
  chatGptThinkingLevels,
  requireLegacyThinkingLevel,
  apiSamplingThinkingLevel,
} from "./thinking-levels.ts";
import { chatGptThinkingOptions } from "../runtime-host/chatgpt-resolution.ts";
import { thinkingProviderOptions, resolveLLMCall } from "./providers.ts";

test("extended subscription levels round-trip through runtime and compaction config", () => {
  const config = runtimeConfigSchema.parse({
    thinkingLevel: "max",
    compaction: { thinkingLevel: "xhigh" },
  });
  assert.equal(config.thinkingLevel, "max");
  assert.equal(config.compaction.thinkingLevel, "xhigh");
  assert.equal(runtimeConfigSchema.parse({}).thinkingLevel, "medium");
});

test("subscription capability normalization is ordered, conservative and deduplicated", () => {
  assert.deepEqual(
    chatGptThinkingLevels({ reasoningEfforts: ["max", "high", "low", "xhigh", "high", "future"] }),
    ["low", "high", "xhigh", "max"],
  );
  assert.deepEqual(chatGptThinkingLevels({ reasoningEfforts: ["none", "medium"] }), [
    "off",
    "medium",
  ]);
  assert.deepEqual(chatGptThinkingLevels(), ["off", "low", "medium", "high"]);
  assert.deepEqual(chatGptThinkingLevels({ reasoningEfforts: [] }), []);
});

test("subscription validates native extended efforts without silent downgrades", () => {
  const model = {
    slug: "subscription",
    displayName: "Subscription",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  };
  for (const level of ["xhigh", "max"] as const) {
    assert.deepEqual(chatGptThinkingOptions(level, model), { openai: { reasoningEffort: level } });
    assert.throws(() => chatGptThinkingOptions(level), /不支持推理强度/);
  }
  assert.throws(() => chatGptThinkingOptions("off", model), /不支持推理强度/);
});

test("standalone API Sampling stays independent of subscription extended chat effort with an explicit warning", () => {
  const warnings: string[] = [];
  for (const level of ["xhigh", "max"] as const) {
    const resolved = apiSamplingThinkingLevel(
      { provider: "chatgpt", thinkingLevel: level },
      "openai",
      (message) => warnings.push(message),
    );
    assert.equal(resolved, "medium");
    assert.match(warnings.at(-1) ?? "", /独立 API Sampling.*默认 medium/);
    assert.deepEqual(
      resolveLLMCall("openai", "gpt-5.4", "fixture", "sampling", undefined, resolved)
        .providerOptions,
      { openai: { reasoningEffort: "medium" } },
    );
    assert.throws(
      () =>
        apiSamplingThinkingLevel({ provider: "openai", thinkingLevel: level }, "openai", () => {}),
      /不支持推理强度/,
    );
  }
  for (const level of ["off", "low", "medium", "high"] as const) {
    assert.equal(
      apiSamplingThinkingLevel({ provider: "chatgpt", thinkingLevel: level }, "openai", () => {
        throw new Error("legacy levels must not warn");
      }),
      level,
    );
  }
});

test("all API purposes reject extended levels before legacy provider mapping", () => {
  for (const provider of ["openai", "anthropic", "qwen", "google", "deepseek", "xai"]) {
    for (const level of ["xhigh", "max"] as const) {
      assert.throws(() => thinkingProviderOptions(provider, "fixture", level), /不支持推理强度/);
      for (const purpose of ["chat", "sampling", "structured-output", "text"] as const) {
        assert.throws(
          () => resolveLLMCall(provider, "fixture", "fixture", purpose, undefined, level),
          /不支持推理强度/,
        );
      }
    }
  }
  assert.equal(requireLegacyThinkingLevel("medium", "openai"), "medium");
  assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-5", "high"), {
    anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
  });
});
