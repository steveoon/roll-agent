import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderModel } from "./providers.ts";

describe("createProviderModel", () => {
  it("should create an anthropic model", () => {
    const model = createProviderModel("anthropic", "claude-sonnet-4-20250514", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "claude-sonnet-4-20250514");
  });

  it("should create an openai model", () => {
    const model = createProviderModel("openai", "gpt-4o", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "gpt-4o");
  });

  it("should create a qwen model", () => {
    const model = createProviderModel("qwen", "qwen-plus", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "qwen-plus");
  });

  it("should throw for unknown provider", () => {
    assert.throws(
      () => createProviderModel("nonexistent", "model", "key"),
      (err: Error) => err.message.includes("Unknown LLM provider"),
    );
  });
});
