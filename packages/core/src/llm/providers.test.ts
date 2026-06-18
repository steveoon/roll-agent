import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderModel, resolveLLMCall, thinkingProviderOptions } from "./providers.ts";

describe("createProviderModel", () => {
  it("should create an anthropic model", () => {
    const model = createProviderModel("anthropic", "claude-sonnet-4-6", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "claude-sonnet-4-6");
  });

  it("should create an openai model", () => {
    const model = createProviderModel("openai", "gpt-5.5", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "gpt-5.5");
  });

  it("should create a deepseek model", () => {
    const model = createProviderModel("deepseek", "deepseek-v4-flash", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "deepseek-v4-flash");
  });

  it("should create a qwen model", () => {
    const model = createProviderModel("qwen", "qwen3.6-plus", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "qwen3.6-plus");
  });

  it("should accept custom baseURL", () => {
    const model = createProviderModel(
      "openai",
      "gpt-5.5",
      "test-key",
      "https://custom-api.example.com/v1",
    );
    assert.ok(model);
    assert.equal(model.modelId, "gpt-5.5");
  });

  it("should throw for unknown provider", () => {
    assert.throws(
      () => createProviderModel("nonexistent", "model", "key"),
      (err: Error) => err.message.includes("Unknown LLM provider"),
    );
  });
});

describe("resolveLLMCall", () => {
  it("disables thinking for qwen structured-output calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.6-plus", "test-key", "structured-output");

    assert.equal(resolved.model.modelId, "qwen3.6-plus");
    assert.deepEqual(resolved.providerOptions, {
      alibaba: {
        enableThinking: false,
      },
    });
  });

  it("does not inject providerOptions for qwen text calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.6-plus", "test-key", "text");

    assert.equal(resolved.model.modelId, "qwen3.6-plus");
    assert.equal(resolved.providerOptions, undefined);
  });

  it("applies medium thinking by default for qwen chat calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.7-plus", "test-key", "chat");

    assert.equal(resolved.model.modelId, "qwen3.7-plus");
    assert.deepEqual(resolved.providerOptions, {
      alibaba: { enableThinking: true, thinkingBudget: 8192 },
    });
  });

  it("applies the requested thinking level for chat calls", () => {
    const off = resolveLLMCall("qwen", "qwen3.7-plus", "k", "chat", undefined, "off");
    assert.deepEqual(off.providerOptions, { alibaba: { enableThinking: false } });
    const high = resolveLLMCall("anthropic", "claude-sonnet-4-6", "k", "chat", undefined, "high");
    assert.deepEqual(high.providerOptions, {
      anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    });
  });

  it("does not inject providerOptions for non-qwen structured-output calls", () => {
    const resolved = resolveLLMCall(
      "openai",
      "gpt-5.5",
      "test-key",
      "structured-output",
      "https://custom-api.example.com/v1",
    );

    assert.equal(resolved.model.modelId, "gpt-5.5");
    assert.equal(resolved.providerOptions, undefined);
  });
});

describe("thinkingProviderOptions", () => {
  it("maps openai reasoningEffort and only sends none to compatible models", () => {
    assert.deepEqual(thinkingProviderOptions("openai", "gpt-5.5", "high"), {
      openai: { reasoningEffort: "high" },
    });
    assert.deepEqual(thinkingProviderOptions("openai", "gpt-5.1", "off"), {
      openai: { reasoningEffort: "none" },
    });
    assert.equal(thinkingProviderOptions("openai", "gpt-5.5", "off"), undefined);
  });

  it("maps anthropic 4.6+ thinking to adaptive effort", () => {
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-6", "low"), {
      anthropic: { thinking: { type: "adaptive" }, effort: "low" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-opus-5-0", "high"), {
      anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    });
  });

  it("maps older anthropic thinking to enabled/disabled with budget", () => {
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-5", "low"), {
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-6", "off"), {
      anthropic: { thinking: { type: "disabled" } },
    });
  });

  it("maps qwen enableThinking + budget and deepseek toggle", () => {
    assert.deepEqual(thinkingProviderOptions("qwen", "qwen3.7-plus", "medium"), {
      alibaba: { enableThinking: true, thinkingBudget: 8192 },
    });
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "off"), {
      deepseek: { thinking: { type: "disabled" } },
    });
  });

  it("treats deepseek effort levels as on-only (no effort granularity)", () => {
    const enabled = { deepseek: { thinking: { type: "enabled" } } };
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "low"), enabled);
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "medium"), enabled);
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "high"), enabled);
  });

  it("returns undefined for unknown providers", () => {
    assert.equal(thinkingProviderOptions("mystery", "model", "high"), undefined);
  });
});
