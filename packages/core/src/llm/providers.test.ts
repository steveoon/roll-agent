import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderModel, resolveLLMCall, thinkingProviderOptions } from "./providers.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("createProviderModel", () => {
  it("should create an anthropic model", () => {
    const model = createProviderModel("anthropic", "claude-sonnet-4-6", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "claude-sonnet-4-6");
  });

  it("should create an openai model", () => {
    const model = createProviderModel("openai", "gpt-5.5", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "gpt-5.5");
  });

  it("should create a deepseek model", () => {
    const model = createProviderModel("deepseek", "deepseek-v4-flash", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "deepseek-v4-flash");
  });

  it("should create a qwen model", () => {
    const model = createProviderModel("qwen", "qwen3.6-plus", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "qwen3.6-plus");
  });

  it("should create an xAI model", () => {
    const model = createProviderModel("xai", "grok-4.5", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "grok-4.5");
    assert.equal(model.provider, "xai.responses");
  });

  it("should accept custom baseURL", () => {
    const model = createProviderModel(
      "openai",
      "gpt-5.5",
      "test-key",
      "https://custom-api.example.com/v1",
    );
    assert.ok(model);
    assert.equal(model.modelId, "gpt-5.5");
  });

  it("should throw for unknown provider", () => {
    assert.throws(
      () => createProviderModel("nonexistent", "model", "key"),
      (err: Error) => err.message.includes("Unknown LLM provider"),
    );
  });
});

describe("resolveLLMCall", () => {
  it("disables thinking for qwen structured-output calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.6-plus", "test-key", "structured-output");

    assert.equal(resolved.model.modelId, "qwen3.6-plus");
    assert.deepEqual(resolved.providerOptions, {
      alibaba: {
        enableThinking: false,
      },
    });
  });

  it("does not inject providerOptions for qwen text calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.6-plus", "test-key", "text");

    assert.equal(resolved.model.modelId, "qwen3.6-plus");
    assert.equal(resolved.providerOptions, undefined);
  });

  it("applies medium thinking by default for qwen chat calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.7-plus", "test-key", "chat");

    assert.equal(resolved.model.modelId, "qwen3.7-plus");
    assert.deepEqual(resolved.providerOptions, {
      alibaba: { enableThinking: true, thinkingBudget: 8192 },
    });
  });

  it("applies visible medium reasoning by default for xAI chat calls", () => {
    const resolved = resolveLLMCall("xai", "grok-4.5", "test-key", "chat");

    assert.equal(resolved.model.modelId, "grok-4.5");
    assert.deepEqual(resolved.providerOptions, {
      xai: { reasoningEffort: "medium", reasoningSummary: "auto" },
    });
  });

  it("applies the requested thinking level for chat calls", () => {
    const off = resolveLLMCall("qwen", "qwen3.7-plus", "k", "chat", undefined, "off");
    assert.deepEqual(off.providerOptions, { alibaba: { enableThinking: false } });
    const high = resolveLLMCall("anthropic", "claude-sonnet-4-6", "k", "chat", undefined, "high");
    assert.deepEqual(high.providerOptions, {
      anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    });
  });

  it("does not inject providerOptions for non-qwen structured-output calls", () => {
    const resolved = resolveLLMCall(
      "openai",
      "gpt-5.5",
      "test-key",
      "structured-output",
      "https://custom-api.example.com/v1",
    );

    assert.equal(resolved.model.modelId, "gpt-5.5");
    assert.equal(resolved.providerOptions, undefined);
  });

  it("keeps the exact OpenAI model and replays history for custom Responses endpoints", () => {
    const chat = resolveLLMCall(
      "openai",
      "gpt-5.4",
      "test-key",
      "chat",
      "https://custom-api.example.com/v1",
    );
    const sampling = resolveLLMCall(
      "openai",
      "gpt-5.4",
      "test-key",
      "sampling",
      "https://custom-api.example.com/v1",
      "high",
    );
    const withoutReasoning = resolveLLMCall(
      "openai",
      "gpt-4.1",
      "test-key",
      "chat",
      "https://custom-api.example.com/v1",
      "off",
    );

    assert.equal(chat.model.modelId, "gpt-5.4");
    assert.deepEqual(chat.providerOptions, {
      openai: { reasoningEffort: "medium", store: false },
    });
    assert.deepEqual(sampling.providerOptions, {
      openai: { reasoningEffort: "high", store: false },
    });
    assert.deepEqual(withoutReasoning.providerOptions, {
      openai: { store: false },
    });
  });

  it("keeps the OpenAI Responses storage default without an explicit base URL", () => {
    const resolved = resolveLLMCall("openai", "gpt-5.4", "test-key", "chat");

    assert.deepEqual(resolved.providerOptions, {
      openai: { reasoningEffort: "medium" },
    });
  });

  it("serializes custom OpenAI-compatible history without item references", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedBody: unknown;

    try {
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = input instanceof Request ? input.url : String(input);
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body);

        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const resolved = resolveLLMCall(
        "openai",
        "gpt-5.4",
        "test-key",
        "chat",
        "https://custom-api.example.com/v1",
      );
      const result = await resolved.model.doStream({
        prompt: [
          {
            role: "user",
            content: [{ type: "text", text: "first" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "first answer",
                providerOptions: { openai: { itemId: "msg_123" } },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "text", text: "second" }],
          },
        ],
        ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
      });
      await result.stream.cancel();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(capturedUrl, "https://custom-api.example.com/v1/responses");
    assert.ok(isRecord(capturedBody));
    assert.equal(capturedBody.store, false);

    const rawInput = capturedBody.input;
    assert.ok(Array.isArray(rawInput));
    const input: readonly unknown[] = rawInput;
    assert.equal(
      input.some((item) => isRecord(item) && item.type === "item_reference"),
      false,
    );
    assert.equal(
      input.some((item) => isRecord(item) && item.role === "assistant"),
      true,
    );
  });

  it("serializes xAI reasoning through the Responses API", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedBody: unknown;

    try {
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = input instanceof Request ? input.url : String(input);
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body);

        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const resolved = resolveLLMCall("xai", "grok-4.5", "test-key", "chat");
      const result = await resolved.model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
      });
      await result.stream.cancel();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(capturedUrl, "https://api.x.ai/v1/responses");
    assert.ok(isRecord(capturedBody));
    assert.deepEqual(capturedBody.reasoning, { effort: "medium", summary: "auto" });
  });

  it("applies the same thinking mapping to sampling calls as chat calls", () => {
    const chatOff = resolveLLMCall("qwen", "qwen3.7-plus", "k", "chat", undefined, "off");
    const samplingOff = resolveLLMCall("qwen", "qwen3.7-plus", "k", "sampling", undefined, "off");
    assert.deepEqual(samplingOff.providerOptions, chatOff.providerOptions);

    const chatHigh = resolveLLMCall(
      "anthropic",
      "claude-sonnet-4-6",
      "k",
      "chat",
      undefined,
      "high",
    );
    const samplingHigh = resolveLLMCall(
      "anthropic",
      "claude-sonnet-4-6",
      "k",
      "sampling",
      undefined,
      "high",
    );
    assert.deepEqual(samplingHigh.providerOptions, chatHigh.providerOptions);
  });

  it("applies medium thinking by default for sampling calls", () => {
    const resolved = resolveLLMCall("qwen", "qwen3.7-plus", "test-key", "sampling");

    assert.deepEqual(resolved.providerOptions, {
      alibaba: { enableThinking: true, thinkingBudget: 8192 },
    });
  });
});

describe("thinkingProviderOptions", () => {
  it("maps openai reasoningEffort and only sends none to compatible models", () => {
    assert.deepEqual(thinkingProviderOptions("openai", "gpt-5.5", "high"), {
      openai: { reasoningEffort: "high" },
    });
    assert.deepEqual(thinkingProviderOptions("openai", "gpt-5.1", "off"), {
      openai: { reasoningEffort: "none" },
    });
    assert.equal(thinkingProviderOptions("openai", "gpt-5.5", "off"), undefined);
  });

  it("maps anthropic 4.6+ thinking to adaptive effort", () => {
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-6", "low"), {
      anthropic: { thinking: { type: "adaptive" }, effort: "low" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-opus-5-0", "high"), {
      anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-5", "medium"), {
      anthropic: { thinking: { type: "adaptive" }, effort: "medium" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-fable-5", "high"), {
      anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-5-20260601", "low"), {
      anthropic: { thinking: { type: "adaptive" }, effort: "low" },
    });
  });

  it("maps older anthropic thinking to enabled/disabled with budget", () => {
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-5", "low"), {
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-20250514", "low"), {
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-haiku-4-5", "low"), {
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-6", "off"), {
      anthropic: { thinking: { type: "disabled" } },
    });
  });

  it("maps qwen enableThinking + budget and deepseek toggle", () => {
    assert.deepEqual(thinkingProviderOptions("qwen", "qwen3.7-plus", "medium"), {
      alibaba: { enableThinking: true, thinkingBudget: 8192 },
    });
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "off"), {
      deepseek: { thinking: { type: "disabled" } },
    });
  });

  it("maps xAI reasoning effort and requests visible summaries", () => {
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.5", "off"), {
      xai: { reasoningEffort: "none" },
    });
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.5", "low"), {
      xai: { reasoningEffort: "low", reasoningSummary: "auto" },
    });
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.5", "medium"), {
      xai: { reasoningEffort: "medium", reasoningSummary: "auto" },
    });
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.5", "high"), {
      xai: { reasoningEffort: "high", reasoningSummary: "auto" },
    });
  });

  it("respects xAI models with fixed or disabled reasoning", () => {
    assert.equal(thinkingProviderOptions("xai", "grok-4.20-non-reasoning", "high"), undefined);
    assert.equal(thinkingProviderOptions("xai", "grok-4.20-reasoning", "off"), undefined);
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.20-reasoning", "medium"), {
      xai: { reasoningSummary: "auto" },
    });
    assert.equal(thinkingProviderOptions("xai", "grok-3", "medium"), undefined);
  });

  it("treats deepseek effort levels as on-only (no effort granularity)", () => {
    const enabled = { deepseek: { thinking: { type: "enabled" } } };
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "low"), enabled);
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "medium"), enabled);
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "high"), enabled);
  });

  it("returns undefined for unknown providers", () => {
    assert.equal(thinkingProviderOptions("mystery", "model", "high"), undefined);
  });
});
