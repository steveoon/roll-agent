import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSamplingGenerateTextParams } from "./sampling-handler.ts";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";

const FAKE_MODEL = { modelId: "fake-model" } as unknown as LanguageModelV4;
const MESSAGES: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

describe("buildSamplingGenerateTextParams", () => {
  it("includes maxOutputTokens when maxTokens is positive", () => {
    const params = buildSamplingGenerateTextParams(FAKE_MODEL, MESSAGES, 512);

    assert.equal(params.maxOutputTokens, 512);
    assert.equal("providerOptions" in params, false);
  });

  it("omits maxOutputTokens when maxTokens is zero or negative", () => {
    const zero = buildSamplingGenerateTextParams(FAKE_MODEL, MESSAGES, 0);
    const negative = buildSamplingGenerateTextParams(FAKE_MODEL, MESSAGES, -1);

    assert.equal("maxOutputTokens" in zero, false);
    assert.equal("maxOutputTokens" in negative, false);
  });

  it("includes providerOptions when provided", () => {
    const providerOptions: SharedV4ProviderOptions = {
      anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    };
    const params = buildSamplingGenerateTextParams(FAKE_MODEL, MESSAGES, 100, providerOptions);

    assert.deepEqual(params.providerOptions, providerOptions);
  });

  it("omits providerOptions when not provided", () => {
    const params = buildSamplingGenerateTextParams(FAKE_MODEL, MESSAGES, 100);

    assert.equal("providerOptions" in params, false);
  });
});
