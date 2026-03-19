import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import type { AgentTool } from "../types/agent.ts";
import { extractToolInput } from "./argument-extractor.ts";
import { createExtractionSchema } from "./extraction-schema.ts";

function makeMockModel(jsonText: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: jsonText }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function makeStructuredOutputFallbackModel(fallbackText: string): MockLanguageModelV3 {
  let callCount = 0;

  return new MockLanguageModelV3({
    doGenerate: async () => {
      callCount += 1;

      if (callCount === 1) {
        throw new Error("provider rejected structured output schema");
      }

      return {
        content: [{ type: "text", text: fallbackText }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

const syncBrandDataTool: AgentTool = {
  name: "sync_brand_data",
  description: "同步品牌数据到本地",
  inputSchema: {
    type: "object",
    properties: {
      brandAlias: {
        type: "string",
        description: "品牌别名，如 肯德基、KFC",
      },
      cityName: {
        type: "string",
        description: '标准城市名，如 "上海市"',
      },
    },
    required: ["cityName"],
    additionalProperties: false,
  },
};

describe("extractToolInput", () => {
  it("extracts tool arguments using the schema field names", async () => {
    const input = await extractToolInput(
      "同步一下肯德基上海的品牌数据",
      syncBrandDataTool,
      makeMockModel(
        JSON.stringify({
          brandAlias: "肯德基",
          cityName: "上海市",
        }),
      ),
    );

    assert.deepEqual(input, {
      brandAlias: "肯德基",
      cityName: "上海市",
    });
  });

  it("falls back to plain JSON text when structured output is rejected", async () => {
    const model = makeStructuredOutputFallbackModel(
      '```json\n{"brandAlias":"肯德基","cityName":"上海市"}\n```',
    );

    const input = await extractToolInput("同步一下肯德基上海的品牌数据", syncBrandDataTool, model);

    assert.deepEqual(input, {
      brandAlias: "肯德基",
      cityName: "上海市",
    });
    assert.equal(model.doGenerateCalls.length, 2);
  });
});

type JsonSchemaLike = Record<string, unknown> & {
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: boolean;
};

describe("createExtractionSchema", () => {
  it("adds additionalProperties: false to all object nodes", () => {
    const result = createExtractionSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        nested: {
          type: "object",
          properties: {
            foo: { type: "string" },
          },
          required: [],
        },
      },
      required: ["name"],
    }) as JsonSchemaLike;

    assert.equal(result.additionalProperties, false);
    const nestedProp = result.properties?.nested;
    assert.equal(nestedProp?.type, "object");
    assert.equal(nestedProp?.additionalProperties, false);
    assert.deepEqual(result.required, ["name"]);
  });

  it("drops z.record()-like fields (object without properties) from extraction schema", () => {
    const result = createExtractionSchema({
      type: "object",
      properties: {
        message: { type: "string" },
        config: {
          type: "object",
          properties: {
            chatModel: { type: "string" },
            providerConfigs: {
              type: "object",
              // no properties — z.record() pattern, not extractable from NL
            },
          },
          required: [],
        },
      },
      required: ["message"],
    }) as JsonSchemaLike;

    const configProp = result.properties?.config;
    const configProperties = configProp?.properties as Record<string, Record<string, unknown>>;
    // providerConfigs dropped entirely — not collapsed to string
    assert.equal(configProperties?.providerConfigs, undefined);
    // extractable sibling field retained
    assert.ok(configProperties?.chatModel);
  });

  it("drops top-level z.record() fields, preflight catches missing required ones", () => {
    const result = createExtractionSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        metadata: {
          type: "object",
          // no properties — open-ended record
        },
      },
      required: ["name", "metadata"],
    }) as JsonSchemaLike;

    // metadata is dropped from extraction schema
    assert.equal(result.properties?.metadata, undefined);
    // name is retained
    assert.ok(result.properties?.name);
    // required only lists extractable fields
    assert.deepEqual(result.required, ["name"]);
  });

  it("keeps optional enum fields as omitted fields instead of nullable unions", () => {
    const result = createExtractionSchema({
      type: "object",
      properties: {
        channelType: {
          type: "string",
          enum: ["public", "private"],
        },
      },
      required: [],
    }) as JsonSchemaLike;

    const channelType = result.properties?.channelType;
    assert.equal(channelType?.type, "string");
    assert.deepEqual(channelType?.enum, ["public", "private"]);
    assert.equal(result.required, undefined);
  });

  it("keeps optional scalar fields optional without adding null to the type", () => {
    const result = createExtractionSchema({
      type: "object",
      properties: {
        limit: {
          type: "integer",
        },
      },
      required: [],
    }) as JsonSchemaLike;

    const limit = result.properties?.limit;
    assert.equal(limit?.type, "integer");
    assert.equal(result.required, undefined);
  });

  it("preserves optional object omission while keeping nested required fields", () => {
    const result = createExtractionSchema({
      type: "object",
      properties: {
        context: {
          type: "object",
          properties: {
            channelType: {
              type: "string",
              enum: ["public", "private"],
            },
            message: {
              type: "string",
            },
          },
          required: ["channelType"],
        },
      },
      required: [],
    }) as JsonSchemaLike;

    const context = result.properties?.context as JsonSchemaLike | undefined;
    assert.equal(context?.type, "object");
    assert.equal(result.required, undefined);
    assert.deepEqual(context?.required, ["channelType"]);
    assert.deepEqual(context?.properties?.channelType?.enum, ["public", "private"]);
  });

  it("preserves enum items inside arrays", () => {
    const result = createExtractionSchema({
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
            enum: ["a", "b"],
          },
        },
      },
      required: [],
    }) as JsonSchemaLike;

    const tags = result.properties?.tags;
    assert.equal(tags?.type, "array");
    assert.deepEqual(tags?.items, {
      type: "string",
      enum: ["a", "b"],
    });
  });
});
