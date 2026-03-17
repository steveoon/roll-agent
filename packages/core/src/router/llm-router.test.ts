import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { routeWithLLM } from "./llm-router.ts";
import type { RegisteredAgent } from "../types/agent.ts";

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

const agents: RegisteredAgent[] = [
  {
    skill: {
      name: "smart-reply-agent",
      description: "回复候选人并同步品牌数据",
      metadata: {},
    },
    transport: { type: "stdio", command: "node" },
    installPath: "/tmp/smart-reply-agent",
    registeredAt: "2026-01-01T00:00:00.000Z",
    status: "online",
    skillBody: "Tools: generate_reply, sync_brand_data",
  },
];

describe("routeWithLLM", () => {
  it("returns only agent, tool, and confidence from the routing stage", async () => {
    const selection = await routeWithLLM(
      "同步一下肯德基上海的品牌数据",
      agents,
      makeMockModel(
        JSON.stringify({
          agentName: "smart-reply-agent",
          toolName: "sync_brand_data",
          confidence: 0.96,
        }),
      ),
    );

    assert.deepEqual(selection, {
      agentName: "smart-reply-agent",
      toolName: "sync_brand_data",
      confidence: 0.96,
    });
  });
});
