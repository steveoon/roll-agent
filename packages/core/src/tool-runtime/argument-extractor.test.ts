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
    // optional object becomes nullable ["object", "null"]
    assert.deepEqual(nestedProp?.type, ["object", "null"]);
    assert.equal(nestedProp?.additionalProperties, false);
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
});
