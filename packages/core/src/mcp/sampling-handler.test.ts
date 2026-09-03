import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildSamplingGenerateTextParams, registerSamplingHandler } from "./sampling-handler.ts";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
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

  it("preserves the MCP maxTokens limit when alibaba thinking budget is larger", () => {
    const providerOptions: SharedV4ProviderOptions = {
      alibaba: { enableThinking: true, thinkingBudget: 8192 },
    };
    const params = buildSamplingGenerateTextParams(FAKE_MODEL, MESSAGES, 1024, providerOptions);

    assert.equal(params.maxOutputTokens, 1024);
  });
});

it("registerSamplingHandler applies updated providerOptions to subsequent requests", async () => {
  type SamplingRequestHandler = (request: {
    readonly params: {
      readonly messages: ReadonlyArray<{
        readonly role: string;
        readonly content: unknown;
      }>;
      readonly maxTokens: number;
    };
  }) => Promise<unknown>;

  let requestHandler: SamplingRequestHandler = async () => undefined;
  const client = {
    setRequestHandler: (_schema: unknown, handler: SamplingRequestHandler) => {
      requestHandler = handler;
    },
  } as unknown as Client;
  const model = new MockLanguageModelV4({
    doGenerate: async (_options: LanguageModelV4CallOptions) => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
  const initialOptions: SharedV4ProviderOptions = {
    alibaba: { enableThinking: true, thinkingBudget: 2048 },
  };
  const nextOptions: SharedV4ProviderOptions = {
    alibaba: { enableThinking: false },
  };
  const controller = registerSamplingHandler(client, model, initialOptions);
  const request = {
    params: {
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      maxTokens: 128,
    },
  };

  await requestHandler(request);
  controller.setProviderOptions(nextOptions);
  await requestHandler(request);

  assert.deepEqual(model.doGenerateCalls[0]?.providerOptions, initialOptions);
  assert.deepEqual(model.doGenerateCalls[1]?.providerOptions, nextOptions);
});

it("registerSamplingHandler routes subsequent requests to a swapped model", async () => {
  type SamplingRequestHandler = (request: {
    readonly params: {
      readonly messages: ReadonlyArray<{
        readonly role: string;
        readonly content: unknown;
      }>;
      readonly maxTokens: number;
    };
  }) => Promise<unknown>;

  let requestHandler: SamplingRequestHandler = async () => undefined;
  const client = {
    setRequestHandler: (_schema: unknown, handler: SamplingRequestHandler) => {
      requestHandler = handler;
    },
  } as unknown as Client;
  const generateResult = () => ({
    content: [{ type: "text" as const, text: "ok" }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
  });
  const first = new MockLanguageModelV4({
    modelId: "first",
    doGenerate: async (_options: LanguageModelV4CallOptions) => generateResult(),
  });
  const second = new MockLanguageModelV4({
    modelId: "second",
    doGenerate: async (_options: LanguageModelV4CallOptions) => generateResult(),
  });
  const controller = registerSamplingHandler(client, first);
  const request = {
    params: {
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      maxTokens: 128,
    },
  };

  await requestHandler(request);
  controller.setModel(second);
  await requestHandler(request);

  assert.equal(first.doGenerateCalls.length, 1);
  assert.equal(second.doGenerateCalls.length, 1);
});
