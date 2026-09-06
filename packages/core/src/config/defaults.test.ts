import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LLM_MODELS, LLM_PROVIDER_LABELS, LLM_PROVIDER_OPTIONS } from "./defaults.ts";

describe("LLM provider option tables", () => {
  it("keeps labels and default models aligned with LLM_PROVIDER_OPTIONS", () => {
    for (const provider of LLM_PROVIDER_OPTIONS) {
      assert.ok(LLM_PROVIDER_LABELS[provider].length > 0, `${provider} label`);
      assert.ok(DEFAULT_LLM_MODELS[provider].length > 0, `${provider} default model`);
    }
    assert.equal(LLM_PROVIDER_LABELS.xai, "xAI Grok");
    assert.equal(LLM_PROVIDER_LABELS.google, "Google Gemini");
  });
});
