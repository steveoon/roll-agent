import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  applyOpenAiResponsesToolStrictDefaults,
  withDefaultFalseFunctionToolStrict,
} from "./openai-tool-strict.ts";

describe("openai-tool-strict", () => {
  const schema = {
    type: "object" as const,
    properties: { id: { type: "string" as const } },
    required: ["id"],
    additionalProperties: false,
  };

  it("defaults omitted function strict to false without mutating input objects", () => {
    const omitted: LanguageModelV4FunctionTool = Object.freeze({
      type: "function",
      name: "omitted",
      inputSchema: schema,
    });
    const explicitTrue: LanguageModelV4FunctionTool = Object.freeze({
      type: "function",
      name: "explicit_true",
      inputSchema: schema,
      strict: true,
    });
    const explicitFalse: LanguageModelV4FunctionTool = Object.freeze({
      type: "function",
      name: "explicit_false",
      inputSchema: schema,
      strict: false,
    });

    const normalizedOmitted = withDefaultFalseFunctionToolStrict(omitted);
    assert.notStrictEqual(normalizedOmitted, omitted);
    assert.equal(normalizedOmitted.strict, false);
    assert.equal("strict" in omitted, false);
    assert.strictEqual(withDefaultFalseFunctionToolStrict(explicitTrue), explicitTrue);
    assert.strictEqual(withDefaultFalseFunctionToolStrict(explicitFalse), explicitFalse);
  });

  it("preserves array identity when no function tool omits strict and keeps provider tools intact", () => {
    const providerTool = Object.freeze({
      type: "provider" as const,
      id: "openai.web_search" as const,
      name: "web_search",
      args: {},
    });
    const alreadyExplicit: NonNullable<LanguageModelV4CallOptions["tools"]> = [
      { type: "function", name: "a", inputSchema: schema, strict: true },
      { type: "function", name: "b", inputSchema: schema, strict: false },
      providerTool,
    ];
    assert.equal(applyOpenAiResponsesToolStrictDefaults(undefined), undefined);
    assert.strictEqual(applyOpenAiResponsesToolStrictDefaults(alreadyExplicit), alreadyExplicit);

    const mixed: NonNullable<LanguageModelV4CallOptions["tools"]> = [
      { type: "function", name: "omitted", inputSchema: schema },
      ...alreadyExplicit,
    ];
    const projected = applyOpenAiResponsesToolStrictDefaults(mixed);
    assert.ok(projected);
    assert.notStrictEqual(projected, mixed);
    assert.deepEqual(projected[0], {
      type: "function",
      name: "omitted",
      inputSchema: schema,
      strict: false,
    });
    assert.strictEqual(projected[1], alreadyExplicit[0]);
    assert.strictEqual(projected[2], alreadyExplicit[1]);
    assert.strictEqual(projected[3], providerTool);
  });
});
