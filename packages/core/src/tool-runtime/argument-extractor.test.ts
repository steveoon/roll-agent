import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import type { AgentTool } from "../types/agent.ts";
import { extractToolInput } from "./argument-extractor.ts";

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
