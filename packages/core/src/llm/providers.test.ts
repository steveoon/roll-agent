import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderModel } from "./providers.ts";

describe("createProviderModel", () => {
  it("should create an anthropic model", () => {
    const model = createProviderModel("anthropic", "claude-sonnet-4-20250514", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "claude-sonnet-4-20250514");
  });

  it("should throw for unknown provider", () => {
    assert.throws(
      () => createProviderModel("nonexistent", "model", "key"),
      (err: Error) => err.message.includes("Unknown LLM provider"),
    );
  });
});
