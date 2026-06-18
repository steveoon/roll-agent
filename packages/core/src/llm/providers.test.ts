import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderModel, resolveLLMCall } from "./providers.ts";

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

  it("keeps provider defaults for qwen chat calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.7-plus", "test-key", "chat");

    assert.equal(resolved.model.modelId, "qwen3.7-plus");
    assert.equal(resolved.providerOptions, undefined);
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
