import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeConfigSchema } from "../config/schema.ts";
import {
  apiThinkingLevels,
  chatGptThinkingLevels,
  defaultApiThinkingLevel,
  normalizeGoogleModelId,
  requireApiThinkingLevel,
  requireLegacyThinkingLevel,
  requiresGoogleThinking,
  apiSamplingThinkingLevel,
  supportsGoogleXhighThinking,
  UnsupportedThinkingLevelError,
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

test("Google Gemini 4 separates required-thinking and xhigh capabilities on normalized terminal model IDs", () => {
  assert.equal(normalizeGoogleModelId("models/gemini-4-neon"), "gemini-4-neon");
  assert.equal(normalizeGoogleModelId("google.gemini-4-neon-001"), "gemini-4-neon-001");
  assert.equal(
    normalizeGoogleModelId(
      "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-4-carbon",
    ),
    "gemini-4-carbon",
  );
  assert.equal(
    normalizeGoogleModelId(
      "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-2.5-flash",
    ),
    "gemini-2.5-flash",
  );
  assert.equal(
    normalizeGoogleModelId(
      "projects/gemini-4-carbon-prod/locations/global/publishers/google/models/gemini-4-neon",
    ),
    "gemini-4-neon",
  );

  for (const model of [
    "gemini-4-hydrogen",
    "gemini-4-neon",
    "gemini-4-neon-preview",
    "models/gemini-4-hydrogen",
    "models/gemini-4-neon",
    "google.gemini-4-neon",
    "GEMINI-4-NEON",
    "projects/gemini-4-carbon-prod/locations/global/publishers/google/models/gemini-4-neon",
  ]) {
    assert.equal(requiresGoogleThinking(model), true);
    assert.equal(supportsGoogleXhighThinking(model), true);
    assert.deepEqual(apiThinkingLevels("google", model), ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(apiThinkingLevels("openai", model), ["off", "low", "medium", "high"]);
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      assert.equal(requireApiThinkingLevel(level, "google", model), level);
    }
    for (const unsupported of ["off", "max"] as const) {
      assert.throws(
        () => requireApiThinkingLevel(unsupported, "google", model),
        (error: unknown) =>
          error instanceof UnsupportedThinkingLevelError && /不支持推理强度/.test(error.message),
      );
    }
  }

  for (const model of [
    "gemini-4-argon",
    "gemini-4-carbon",
    "models/gemini-4-argon",
    "models/gemini-4-carbon",
    "google.gemini-4-carbon-001",
    "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-4-carbon",
  ]) {
    assert.equal(requiresGoogleThinking(model), true);
    assert.equal(supportsGoogleXhighThinking(model), false);
    assert.deepEqual(apiThinkingLevels("google", model), ["low", "medium", "high"]);
    for (const level of ["low", "medium", "high"] as const) {
      assert.equal(requireApiThinkingLevel(level, "google", model), level);
    }
    for (const unsupported of ["off", "xhigh", "max"] as const) {
      assert.throws(
        () => requireApiThinkingLevel(unsupported, "google", model),
        (error: unknown) =>
          error instanceof UnsupportedThinkingLevelError && /不支持推理强度/.test(error.message),
      );
    }
  }

  for (const model of [
    "gemini-3.8-flash",
    "models/gemini-3.8-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-2.5-flash",
  ]) {
    assert.equal(requiresGoogleThinking(model), false);
    assert.equal(supportsGoogleXhighThinking(model), false);
    assert.deepEqual(apiThinkingLevels("google", model), ["off", "low", "medium", "high"]);
    for (const level of ["off", "low", "medium", "high"] as const) {
      assert.equal(requireApiThinkingLevel(level, "google", model), level);
    }
    for (const unsupported of ["xhigh", "max"] as const) {
      assert.throws(
        () => requireApiThinkingLevel(unsupported, "google", model),
        (error: unknown) =>
          error instanceof UnsupportedThinkingLevelError && /不支持推理强度/.test(error.message),
      );
    }
  }
});

test("standalone API Sampling downgrades cross-model incompatible efforts to medium while keeping invalid source/same-model errors", () => {
  // 1. Compatible cross-model efforts pass through without warnings.
  for (const model of ["gemini-4-hydrogen", "models/gemini-4-hydrogen"]) {
    assert.equal(
      apiSamplingThinkingLevel(
        { provider: "google", model: "gemini-4-neon", thinkingLevel: "xhigh" },
        "google",
        () => {
          throw new Error("compatible cross-model xhigh must not warn");
        },
        model,
      ),
      "xhigh",
    );
  }
  assert.equal(
    apiSamplingThinkingLevel(
      { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" },
      "openai",
      () => {
        throw new Error("compatible ChatGPT off -> OpenAI must not warn");
      },
      "gpt-5.4",
    ),
    "off",
  );

  // 2. Valid source effort that target cannot inherit downgrades to medium with warning.
  const downgradeCases = [
    {
      name: "ChatGPT off -> Google Neon",
      runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" as const },
      apiProvider: "google",
      apiModel: "gemini-4-neon",
    },
    {
      name: "ChatGPT xhigh -> Google Neon (explicit subscription isolation)",
      runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "xhigh" as const },
      apiProvider: "google",
      apiModel: "gemini-4-neon",
    },
    {
      name: "Google Neon xhigh -> OpenAI",
      runtime: { provider: "google", model: "gemini-4-neon", thinkingLevel: "xhigh" as const },
      apiProvider: "openai",
      apiModel: "gpt-5.4",
    },
    {
      name: "Google Neon xhigh (inherited runtime.provider) -> Google Carbon",
      runtime: { model: "gemini-4-neon", thinkingLevel: "xhigh" as const },
      apiProvider: "google",
      apiModel: "gemini-4-carbon",
    },
    {
      name: "Google Neon xhigh -> Google 3.8 Flash",
      runtime: { provider: "google", model: "gemini-4-neon", thinkingLevel: "xhigh" as const },
      apiProvider: "google",
      apiModel: "gemini-3.8-flash",
    },
    {
      name: "OpenAI off -> Google Carbon",
      runtime: { provider: "openai", model: "gpt-5.4", thinkingLevel: "off" as const },
      apiProvider: "google",
      apiModel: "gemini-4-carbon",
    },
  ];
  for (const item of downgradeCases) {
    const warnings: string[] = [];
    assert.equal(
      apiSamplingThinkingLevel(
        item.runtime,
        item.apiProvider,
        (message) => warnings.push(message),
        item.apiModel,
      ),
      "medium",
      item.name,
    );
    assert.equal(warnings.length, 1, item.name);
    assert.match(warnings[0] ?? "", /独立 API Sampling.*默认 medium/, item.name);
  }

  // 3. Invalid source config or invalid same effective model (including defaults & alias prefixes) still throws.
  const errorCases = [
    {
      name: "same model Neon off (explicit)",
      runtime: { provider: "google", model: "gemini-4-neon", thinkingLevel: "off" as const },
      apiProvider: "google",
      apiModel: "gemini-4-neon",
    },
    {
      name: "same model Neon off (inherited runtime defaults)",
      runtime: { thinkingLevel: "off" as const },
      apiProvider: "google",
      apiModel: "gemini-4-neon",
    },
    {
      name: "same model Neon off (models/ alias prefix)",
      runtime: { provider: "google", model: "models/gemini-4-neon", thinkingLevel: "off" as const },
      apiProvider: "google",
      apiModel: "gemini-4-neon",
    },
    {
      name: "same model 3.8 Flash xhigh (inherited runtime defaults)",
      runtime: { thinkingLevel: "xhigh" as const },
      apiProvider: "google",
      apiModel: "gemini-3.8-flash",
    },
    {
      name: "invalid source Carbon xhigh even when target Neon supports xhigh",
      runtime: { provider: "google", model: "gemini-4-carbon", thinkingLevel: "xhigh" as const },
      apiProvider: "google",
      apiModel: "gemini-4-neon",
    },
    {
      name: "invalid source Neon off even when target OpenAI supports off",
      runtime: { provider: "google", model: "gemini-4-neon", thinkingLevel: "off" as const },
      apiProvider: "openai",
      apiModel: "gpt-5.4",
    },
  ];
  for (const item of errorCases) {
    assert.throws(
      () => apiSamplingThinkingLevel(item.runtime, item.apiProvider, () => {}, item.apiModel),
      /不支持推理强度/,
      item.name,
    );
  }
});

test("model ID normalization trims whitespace/newlines and matches OpenAI Pro case-insensitively", () => {
  assert.equal(normalizeGoogleModelId("  gemini-4-neon\n"), "gemini-4-neon");
  assert.deepEqual(apiThinkingLevels("google", " gemini-4-neon\n"), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(apiThinkingLevels("openai", " GPT-5-PRO "), ["high"]);
  assert.deepEqual(apiThinkingLevels("openai", "GPT-5.4-PRO-2026-03-05"), ["medium", "high"]);
});

test("defaultApiThinkingLevel and API Sampling fall back to a model-supported level for gpt-5-pro", () => {
  assert.equal(defaultApiThinkingLevel("openai", "gpt-5-pro"), "high");
  assert.equal(defaultApiThinkingLevel("openai", "gpt-5-pro-2025-10-06"), "high");
  assert.equal(defaultApiThinkingLevel("openai", "gpt-5.4-pro"), "medium");
  assert.equal(defaultApiThinkingLevel("google", "gemini-4-neon"), "medium");

  assert.equal(
    resolveLLMCall("openai", "gpt-5-pro", "fixture", "structured-output").reasoning,
    "high",
  );
  assert.throws(
    () =>
      resolveLLMCall("openai", "gpt-5-pro", "fixture", "structured-output", undefined, "medium"),
    UnsupportedThinkingLevelError,
  );

  for (const downgradeCase of [
    {
      name: "Google Neon xhigh -> OpenAI gpt-5-pro",
      runtime: { provider: "google", model: "gemini-4-neon", thinkingLevel: "xhigh" as const },
    },
    {
      name: "ChatGPT xhigh -> OpenAI gpt-5-pro",
      runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "xhigh" as const },
    },
    {
      name: "ChatGPT off -> OpenAI gpt-5-pro",
      runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" as const },
    },
  ]) {
    const warnings: string[] = [];
    assert.equal(
      apiSamplingThinkingLevel(
        downgradeCase.runtime,
        "openai",
        (message) => warnings.push(message),
        "gpt-5-pro",
      ),
      "high",
      downgradeCase.name,
    );
    assert.equal(warnings.length, 1, downgradeCase.name);
    assert.match(warnings[0] ?? "", /独立 API Sampling.*默认 high/, downgradeCase.name);
  }

  assert.equal(
    apiSamplingThinkingLevel(
      { provider: "openai", model: "gpt-5-pro", thinkingLevel: "high" },
      "openai",
      () => {
        throw new Error("compatible gpt-5-pro high must not warn");
      },
      "gpt-5-pro",
    ),
    "high",
  );
  assert.throws(
    () => apiSamplingThinkingLevel({ thinkingLevel: "medium" }, "openai", () => {}, "gpt-5-pro"),
    UnsupportedThinkingLevelError,
  );
});
