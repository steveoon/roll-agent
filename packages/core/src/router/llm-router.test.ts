import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { routeWithLLM } from "./llm-router.ts";
import { createDefaultRuntimeForTransport } from "../types/agent.ts";
import type { RegisteredAgent } from "../types/agent.ts";

function makeMockModel(jsonText: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
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

function makeStructuredOutputFallbackModel(
  structuredOutputText: string,
  fallbackText: string,
): MockLanguageModelV4 {
  let callCount = 0;

  return new MockLanguageModelV4({
    doGenerate: async () => {
      callCount += 1;

      return {
        content: [{ type: "text", text: callCount === 1 ? structuredOutputText : fallbackText }],
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

function makeApiErrorModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message: "upstream unavailable",
        url: "https://example.com/chat/completions",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: {},
        responseBody: "unavailable",
        isRetryable: true,
      });
    },
  });
}

const agents: RegisteredAgent[] = [
  {
    skill: {
      name: "smart-reply-agent",
      description: "生成并签发候选人回复信封",
      metadata: {},
    },
    transport: { type: "stdio", command: "node" },
    runtime: createDefaultRuntimeForTransport({ type: "stdio", command: "node" }),
    installPath: "/tmp/smart-reply-agent",
    registeredAt: "2026-01-01T00:00:00.000Z",
    status: "online",
    skillBody: "Tools: generate_reply",
  },
];

describe("routeWithLLM", () => {
  it("returns only agent, tool, and confidence from the routing stage", async () => {
    const selection = await routeWithLLM(
      "给这个 BOSS 直聘候选人生成签名回复",
      agents,
      makeMockModel(
        JSON.stringify({
          agentName: "smart-reply-agent",
          toolName: "generate_reply",
          confidence: 0.96,
        }),
      ),
    );

    assert.deepEqual(selection, {
      agentName: "smart-reply-agent",
      toolName: "generate_reply",
      confidence: 0.96,
    });
  });

  it("clamps confidence into the supported runtime range", async () => {
    const selection = await routeWithLLM(
      "给这个 BOSS 直聘候选人生成签名回复",
      agents,
      makeMockModel(
        JSON.stringify({
          agentName: "smart-reply-agent",
          toolName: "generate_reply",
          confidence: 7,
        }),
      ),
    );

    assert.deepEqual(selection, {
      agentName: "smart-reply-agent",
      toolName: "generate_reply",
      confidence: 1,
    });
  });

  it("passes providerOptions through to generateText", async () => {
    const model = makeMockModel(
      JSON.stringify({
        agentName: "smart-reply-agent",
        toolName: "generate_reply",
        confidence: 0.96,
      }),
    );

    await routeWithLLM("给这个 BOSS 直聘候选人生成签名回复", agents, model, {
      alibaba: {
        enableThinking: false,
      },
    });

    assert.deepEqual(model.doGenerateCalls[0]?.providerOptions, {
      alibaba: {
        enableThinking: false,
      },
    });
  });

  it("falls back to plain JSON text when structured output schema validation fails", async () => {
    const model = makeStructuredOutputFallbackModel(
      JSON.stringify({
        agent: "smart-reply-agent",
        tool: "generate_reply",
        confidence: 0.96,
      }),
      '```json\n{"agentName":"smart-reply-agent","toolName":"generate_reply","confidence":0.96}\n```',
    );

    const selection = await routeWithLLM("给这个 BOSS 直聘候选人生成签名回复", agents, model, {
      alibaba: {
        enableThinking: false,
      },
    });

    assert.deepEqual(selection, {
      agentName: "smart-reply-agent",
      toolName: "generate_reply",
      confidence: 0.96,
    });
    assert.deepEqual(model.doGenerateCalls[0]?.providerOptions, {
      alibaba: {
        enableThinking: false,
      },
    });
    assert.equal(model.doGenerateCalls[1]?.providerOptions, undefined);
  });

  it("does not fall back on API call errors", async () => {
    const model = makeApiErrorModel();

    await assert.rejects(
      () => routeWithLLM("给这个 BOSS 直聘候选人生成签名回复", agents, model),
      (error: unknown) => error instanceof Error && error.message.includes("upstream unavailable"),
    );
    assert.ok(model.doGenerateCalls.length > 0);
    assert.ok(model.doGenerateCalls.every((call) => call.responseFormat?.type === "json"));
  });
});
