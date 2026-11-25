import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, Output, streamText, tool } from "ai";
import { z } from "zod";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  AgentSession,
  buildAgentToolset,
  buildScheduleToolset,
  SCHEDULE_CREATE_TOOL_ID,
  ToolRegistry,
} from "@roll-agent/runtime";
import { createChatGptModel } from "./chatgpt-model.ts";
import { createProviderModel, shouldRetainEmptyReasoningPart } from "./providers.ts";
import { isRecoverableChatGptError } from "./chatgpt-recovery.ts";
import { chatGptThinkingOptions } from "../runtime-host/chatgpt-resolution.ts";
import { withChatGptFastMode } from "./chatgpt-fast-mode.ts";

for (const modelId of ["gpt-6.1-sol", "subscription-slug"]) {
  it(`serializes Fast for ${modelId} in streaming, Sampling and structured compaction`, async () => {
    for (const enabled of [true, false]) {
      const captured: unknown[] = [];
      const model = createChatGptModel({
        modelId,
        getAccessToken: async () => "fixture",
        fetch: async (url, init) => {
          assert.equal(String(url), "https://api.openai.com/v1/responses");
          captured.push(JSON.parse(String(init?.body)));
          const done = completion();
          return sse([
            ...events('{"summary":"ok"}', false),
            { ...done, response: { ...done.response, service_tier: "default" } },
          ]);
        },
      });
      const providerOptions = withChatGptFastMode(
        modelId === "subscription-slug" ? undefined : chatGptThinkingOptions("low"),
        enabled,
      );
      const parts = await collect((await model.doStream({ prompt, providerOptions })).stream);
      assert.equal(
        parts.some((part) => part.type === "error"),
        false,
      );
      assert.equal(
        parts.some(
          (part) =>
            part.type === "stream-start" &&
            part.warnings.some(
              (warning) => warning.type === "unsupported" && warning.feature === "serviceTier",
            ),
        ),
        false,
      );
      await generateText({ model, prompt: "Sampling", providerOptions });
      const result = await generateText({
        model,
        prompt: "Summarize",
        providerOptions,
        output: Output.object({ schema: z.object({ summary: z.string() }) }),
      });
      assert.deepEqual(result.output, { summary: "ok" });
      assert.equal(captured.length, 3);
      for (const request of captured) {
        assert.ok(isRecord(request));
        assert.equal(Object.hasOwn(request, "service_tier"), enabled);
        assert.equal(request.service_tier, enabled ? "priority" : undefined);
        assert.equal(request.model, modelId);
        if (modelId !== "subscription-slug") {
          assert.ok(isRecord(request.reasoning));
          assert.equal(request.reasoning.effort, "low");
        }
        assert.equal(request.stream, true);
        assert.equal(request.store, false);
      }
      assert.equal(providerOptions.openai?.serviceTier, enabled ? "priority" : undefined);
    }
  });
}

it("isolates Fast from ordinary calls sharing a model while token retrieval finishes out of order", async () => {
  let finishFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const firstToken = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let tokenReads = 0;
  const captured: unknown[] = [];
  const model = createChatGptModel({
    modelId: "subscription-slug",
    getAccessToken: async () => {
      if (++tokenReads === 1) {
        assert.ok(firstStarted);
        firstStarted();
        await firstToken;
      }
      return "fixture";
    },
    fetch: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return sse(events());
    },
  });
  const fastOptions = withChatGptFastMode(undefined, true);
  const fast = model.doStream({ prompt, providerOptions: fastOptions });
  try {
    await started;
    const ordinary = await model.doStream({ prompt });
    await collect(ordinary.stream);
    assert.ok(finishFirst);
    finishFirst();
    await collect((await fast).stream);
    assert.equal(captured.length, 2);
    const [normalRequest, fastRequest] = captured;
    assert.ok(isRecord(normalRequest));
    assert.ok(isRecord(fastRequest));
    assert.equal(Object.hasOwn(normalRequest, "service_tier"), false);
    assert.equal(fastRequest.service_tier, "priority");
    assert.equal(fastRequest.model, "subscription-slug");
    assert.equal(fastOptions.openai?.serviceTier, "priority");
  } finally {
    finishFirst?.();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completion() {
  return {
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: 7, output_tokens: 4, output_tokens_details: { reasoning_tokens: 1 } },
    },
  };
}

function events(text = "ok", finish = true): unknown[] {
  return [
    {
      type: "response.created",
      response: { id: "resp-fixture", created_at: 1700000000, model: "subscription-slug" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg-fixture" },
    },
    { type: "response.output_text.delta", item_id: "msg-fixture", output_index: 0, delta: text },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg-fixture" },
    },
    ...(finish ? [completion()] : []),
  ];
}

function sse(values: unknown[]): Response {
  return new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "x-request-id": "fixture-request" },
  });
}

const prompt: LanguageModelV4CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

async function collect(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return parts;
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe("ChatGPT subscription Responses adapter", () => {
  it("preserves native xhigh/max in streaming chat and structured compaction", async () => {
    for (const level of ["xhigh", "max"] as const) {
      const captured: unknown[] = [];
      const model = createChatGptModel({
        modelId: "gpt-6.1-sol",
        getAccessToken: async () => "fixture",
        fetch: async (_url, init) => {
          captured.push(JSON.parse(String(init?.body)));
          return sse(events('{"summary":"ok"}'));
        },
      });
      const providerOptions = chatGptThinkingOptions(level, {
        slug: "gpt-6.1-sol",
        displayName: "Fixture",
        reasoningEfforts: ["xhigh", "max"],
      });
      await collect((await model.doStream({ prompt, providerOptions })).stream);
      await generateText({
        model,
        prompt: "Summarize",
        providerOptions,
        output: Output.object({ schema: z.object({ summary: z.string() }) }),
      });
      assert.equal(captured.length, 2);
      for (const request of captured) {
        assert.ok(isRecord(request));
        assert.ok(isRecord(request.reasoning));
        assert.equal(request.reasoning.effort, level);
      }
    }
  });
  it("serializes off as none for models supporting it in chat and structured compaction", async () => {
    const captured: unknown[] = [];
    const model = createChatGptModel({
      modelId: "gpt-6.1-sol",
      getAccessToken: async () => "fixture",
      fetch: async (_url, init) => {
        captured.push(JSON.parse(String(init?.body)));
        return sse(events('{"summary":"ok"}'));
      },
    });
    await collect(
      (
        await model.doStream({
          prompt,
          providerOptions: chatGptThinkingOptions("off", {
            slug: "gpt-6.1-sol",
            displayName: "Fixture supporting none",
            reasoningEfforts: ["none", "low"],
          }),
        })
      ).stream,
    );
    await generateText({
      model,
      prompt: "Summarize",
      providerOptions: chatGptThinkingOptions("off", {
        slug: "gpt-6.1-sol",
        displayName: "Fixture supporting none",
        reasoningEfforts: ["none", "low"],
      }),
      output: Output.object({ schema: z.object({ summary: z.string() }) }),
    });
    assert.equal(captured.length, 2);
    for (const request of captured) {
      assert.ok(isRecord(request));
      assert.deepEqual(request.reasoning, { effort: "none" });
      assert.equal(request.stream, true);
    }
  });
  it("replays history with developer messages, namespaces unchanged local schemas, and strips forbidden fields", async () => {
    let captured: unknown;
    let auth: string | null = null;
    let tokenReads = 0;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => `rotated-${++tokenReads}`,
      fetch: async (url, init) => {
        assert.equal(String(url), "https://api.openai.com/v1/responses");
        assert.equal(init?.redirect, "error");
        captured = JSON.parse(String(init?.body));
        auth = new Headers(init?.headers).get("Authorization");
        return sse(events());
      },
    });
    const schema = {
      type: "object" as const,
      properties: { path: { type: "string" as const } },
      required: ["path"],
      additionalProperties: false,
    };
    const request: LanguageModelV4CallOptions = {
      prompt: [
        { role: "system", content: "developer instructions" },
        { role: "user", content: [{ type: "text", text: "secret random marker" }] },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "retained assistant history",
              providerOptions: { openai: { itemId: "history-message" } },
            },
            {
              type: "reasoning",
              text: "retained reasoning",
              providerOptions: {
                openai: {
                  itemId: "history-reasoning",
                  reasoningEncryptedContent: "replay-encrypted",
                },
              },
            },
            {
              type: "tool-call",
              toolCallId: "call-old",
              toolName: "roll__read",
              input: { path: "/tmp/fixture" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-old",
              toolName: "roll__read",
              output: { type: "text", value: "synthetic content" },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "remember the marker" }] },
      ],
      tools: [{ type: "function", name: "roll__read", inputSchema: schema }],
      maxOutputTokens: 123,
      temperature: 0.8,
      topP: 0.9,
      providerOptions: {
        openai: {
          store: true,
          previousResponseId: "forbidden-resp",
          user: "forbidden-user",
          maxToolCalls: 5,
        },
      },
    };
    const result = await model.doGenerate(request);
    assert.equal(auth, "Bearer rotated-1");
    assert.ok(isRecord(captured));
    assert.equal(captured.model, "subscription-slug");
    assert.equal(captured.stream, true);
    assert.equal(captured.store, false);
    for (const field of [
      "max_output_tokens",
      "temperature",
      "top_p",
      "previous_response_id",
      "user",
      "max_tool_calls",
    ]) {
      assert.equal(field in captured, false, field);
    }
    assert.ok(Array.isArray(captured.input));
    assert.ok(isRecord(captured.input[0]));
    assert.equal(captured.input[0].role, "developer");
    assert.ok(JSON.stringify(captured.input).includes("secret random marker"));
    assert.ok(JSON.stringify(captured.input).includes("synthetic content"));
    assert.ok(JSON.stringify(captured.input).includes("retained assistant history"));
    assert.ok(JSON.stringify(captured.input).includes("replay-encrypted"));
    assert.deepEqual(captured.include, ["reasoning.encrypted_content"]);
    assert.ok(JSON.stringify(captured.input).includes('"namespace":"roll"'));
    assert.ok(Array.isArray(captured.tools));
    assert.ok(isRecord(captured.tools[0]));
    assert.equal(captured.tools[0].type, "namespace");
    assert.equal(captured.tools[0].name, "roll");
    assert.ok(Array.isArray(captured.tools[0].tools));
    assert.ok(isRecord(captured.tools[0].tools[0]));
    assert.equal(captured.tools[0].tools[0].name, "roll__read");
    assert.equal(captured.tools[0].tools[0].strict, false);
    assert.deepEqual(captured.tools[0].tools[0].parameters, schema);
    assert.ok(
      result.warnings.some(
        (warning) => warning.type === "unsupported" && warning.feature === "maxOutputTokens",
      ),
    );
    for (const feature of ["temperature", "topP"]) {
      assert.ok(
        result.warnings.some(
          (warning) => warning.type === "unsupported" && warning.feature === feature,
        ),
      );
    }
    await model.doGenerate({ prompt });
    assert.equal(auth, "Bearer rotated-2");
  });

  it("aggregates native streaming text, reasoning encrypted metadata, tool calls, usage and response metadata", async () => {
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async () =>
        sse([
          ...events("answer", false),
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "reasoning", id: "reasoning-1", encrypted_content: "early-encrypted" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "reasoning-1",
            output_index: 1,
            summary_index: 0,
            delta: "reason summary",
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: { type: "reasoning", id: "reasoning-1", encrypted_content: "final-encrypted" },
          },
          {
            type: "response.output_item.added",
            output_index: 2,
            item: {
              type: "function_call",
              id: "function-1",
              call_id: "call-1",
              name: "roll__read",
              namespace: "roll",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "function-1",
            output_index: 2,
            delta: '{"path":"/tmp/test"}',
          },
          {
            type: "response.output_item.done",
            output_index: 2,
            item: {
              type: "function_call",
              id: "function-1",
              call_id: "call-1",
              name: "roll__read",
              namespace: "roll",
              status: "completed",
              arguments: '{"path":"/tmp/test"}',
            },
          },
          completion(),
        ]),
    });
    const result = await model.doGenerate({ prompt });
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : null, "answer");
    const reasoning = result.content.find((part) => part.type === "reasoning");
    assert.equal(reasoning?.text, "reason summary");
    assert.equal(reasoning?.providerMetadata?.openai?.reasoningEncryptedContent, "final-encrypted");
    const tool = result.content.find((part) => part.type === "tool-call");
    assert.equal(tool?.toolName, "roll__read");
    assert.equal(tool?.input, '{"path":"/tmp/test"}');
    assert.equal(tool?.providerMetadata?.openai?.namespace, "roll");
    assert.equal(result.usage.inputTokens.total, 7);
    assert.equal(result.usage.outputTokens.total, 4);
    assert.equal(result.usage.outputTokens.reasoning, 1);
    assert.equal(result.response?.id, "resp-fixture");
    assert.equal(result.response?.headers?.["x-request-id"], "fixture-request");
    assert.equal(result.providerMetadata?.openai?.responseId, "resp-fixture");
  });

  it("uses streaming HTTP for generateText Sampling and schema-validated compaction", async () => {
    const bodies: unknown[] = [];
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        bodies.push(body);
        assert.ok(isRecord(body));
        return sse(
          events(isRecord(body.text) ? '{"summary":"retained marker"}' : "sampling answer"),
        );
      },
    });
    const sampling = await generateText({
      model,
      prompt: "sampling",
      maxOutputTokens: 10,
      maxRetries: 0,
    });
    assert.equal(sampling.text, "sampling answer");
    const compacted = await generateText({
      model,
      prompt: "compact",
      output: Output.object({ schema: z.object({ summary: z.string() }) }),
      maxOutputTokens: 8192,
      maxRetries: 0,
    });
    assert.deepEqual(compacted.output, { summary: "retained marker" });
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.ok(isRecord(body));
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal("max_output_tokens" in body, false);
    }
  });

  it("does not bypass schema validation for an invalid compaction response", async () => {
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async () => sse(events('{"unexpected":"missing summary"}')),
    });
    await assert.rejects(
      generateText({
        model,
        prompt: "compact",
        output: Output.object({ schema: z.object({ summary: z.string() }) }),
        maxRetries: 0,
      }),
      /No object generated|schema/,
    );
  });

  it("exposes parsed direct-stream events and warnings without raw provider chunks", async () => {
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async () => sse(events("direct stream")),
    });
    const result = await model.doStream({ prompt, maxOutputTokens: 100 });
    const parts = await collect(result.stream);
    assert.equal(
      parts.some((part) => part.type === "raw"),
      false,
    );
    assert.ok(parts.some((part) => part.type === "text-delta" && part.delta === "direct stream"));
    assert.ok(
      parts.some(
        (part) =>
          part.type === "stream-start" &&
          part.warnings.some(
            (warning) => warning.type === "unsupported" && warning.feature === "maxOutputTokens",
          ),
      ),
    );
    assert.equal(parts.at(-1)?.type, "finish");
  });

  it("propagates consumer stream cancellation to the HTTP body", async () => {
    let cancelled = false;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  events("partial", false)
                    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join(""),
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const result = await model.doStream({ prompt });
    await result.stream.cancel("fixture consumer canceled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  });

  for (const method of ["doGenerate", "doStream"] as const) {
    it(`recovers EOF during tool arguments but not an invalid completion in ${method}`, async () => {
      for (const completed of [false, true]) {
        const model = createChatGptModel({
          modelId: "subscription-slug",
          getAccessToken: async () => "token",
          fetch: async () =>
            sse([
              {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "partial",
                  call_id: "partial-call",
                  name: "roll__read",
                  arguments: "",
                },
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: "partial",
                output_index: 0,
                delta: '{"path":',
              },
              ...(completed ? [completion()] : []),
            ]),
        });
        await assert.rejects(
          async () => {
            const result = await model[method]({ prompt });
            if ("stream" in result) await collect(result.stream);
          },
          (error: unknown) => {
            assert.equal(isRecoverableChatGptError(error), !completed);
            return true;
          },
        );
      }
    });
    it(`rejects response.completed with a local tool missing output_item.done in ${method}`, async () => {
      const model = createChatGptModel({
        modelId: "subscription-slug",
        getAccessToken: async () => "token",
        fetch: async () =>
          sse([
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "function_call",
                id: "function-partial",
                call_id: "call-partial",
                name: "roll__read",
                namespace: "roll",
                arguments: "",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "function-partial",
              output_index: 0,
              delta: '{"path":',
            },
            completion(),
          ]),
      });
      await assert.rejects(async () => {
        const result = await model[method]({ prompt });
        if ("stream" in result) await collect(result.stream);
      }, /incomplete local function call/);
    });
    it(`rejects truncated streams in ${method}`, async () => {
      const model = createChatGptModel({
        modelId: "subscription-slug",
        getAccessToken: async () => "token",
        fetch: async () => sse(events("partial", false)),
      });
      await assert.rejects(async () => {
        const result = await model[method]({ prompt });
        if ("stream" in result) await collect(result.stream);
      }, /without response.completed|before successful completion/);
    });
    it(`rejects incomplete native Responses in ${method}`, async () => {
      const model = createChatGptModel({
        modelId: "subscription-slug",
        getAccessToken: async () => "token",
        fetch: async () =>
          sse([...events("partial", false), { ...completion(), type: "response.incomplete" }]),
      });
      await assert.rejects(async () => {
        const result = await model[method]({ prompt });
        if ("stream" in result) await collect(result.stream);
      }, /response.incomplete/);
    });
  }

  it("propagates provider errors and never retries through a paid provider", async () => {
    let requests = 0;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async () => {
        requests++;
        return Response.json(
          {
            error: {
              message: "Subscription quota exhausted",
              type: "insufficient_quota",
              code: "insufficient_quota",
            },
          },
          { status: 429 },
        );
      },
    });
    await assert.rejects(async () => model.doGenerate({ prompt }), /Subscription quota exhausted/);
    assert.equal(requests, 1);
  });

  for (const code of ["subscription_sharing_usage_limit_exceeded", "insufficient_quota"] as const) {
    it(`generateText exposes ${code} immediately with its original HTTP diagnostics`, async () => {
      let requests = 0;
      const errorBody = {
        error: { message: "Subscription quota exhausted", type: "quota", code, param: "model" },
      };
      const model = createChatGptModel({
        modelId: "subscription-slug",
        getAccessToken: async () => "token",
        fetch: async () => {
          requests++;
          return Response.json(errorBody, {
            status: 429,
            headers: { "x-request-id": "quota-request-id" },
          });
        },
      });
      await assert.rejects(generateText({ model, prompt: "quota fixture" }), (error: unknown) => {
        assert.ok(APICallError.isInstance(error));
        assert.equal(error.message, "Subscription quota exhausted");
        assert.equal(error.statusCode, 429);
        assert.equal(error.responseHeaders?.["x-request-id"], "quota-request-id");
        assert.deepEqual(error.data, errorBody);
        assert.deepEqual(JSON.parse(error.responseBody ?? "null"), errorBody);
        assert.equal(error.isRetryable, false);
        return true;
      });
      assert.equal(requests, 1);
    });
  }

  it("retains bounded SDK retries for temporary subscription availability failures", async () => {
    let requests = 0;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async () => {
        requests++;
        return requests === 1
          ? Response.json(
              {
                error: {
                  message: "Temporary usage availability failure",
                  type: "server_error",
                  code: "subscription_sharing_usage_unavailable",
                },
              },
              { status: 503 },
            )
          : sse(events("recovered"));
      },
    });
    assert.equal(
      (await generateText({ model, prompt: "availability fixture", maxRetries: 1 })).text,
      "recovered",
    );
    assert.equal(requests, 2);
  });

  it("does not retry a subscription quota error arriving before streaming output", async () => {
    let requests = 0;
    const frame = {
      type: "error",
      sequence_number: 1,
      code: "subscription_sharing_usage_limit_exceeded",
      message: "App subscription usage limit reached",
      param: "model",
    };
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async () => {
        requests++;
        return sse([frame]);
      },
    });
    await assert.rejects(
      generateText({ model, prompt: "stream admission fixture" }),
      (error: unknown) => {
        assert.ok(APICallError.isInstance(error));
        assert.equal(error.message, frame.message);
        assert.deepEqual(error.data, frame);
        assert.equal(error.responseHeaders?.["x-request-id"], "fixture-request");
        assert.equal(error.isRetryable, false);
        return true;
      },
    );
    assert.equal(requests, 1);
  });

  it("retains quota messages from HTTP 200 stream errors and failed events", async () => {
    for (const event of [
      {
        type: "error",
        sequence_number: 1,
        code: "insufficient_quota",
        message: "Subscription quota exhausted",
      },
      {
        type: "response.failed",
        sequence_number: 1,
        response: {
          error: { code: "subscription_disabled", message: "Subscription authorization disabled" },
        },
      },
    ]) {
      const model = createChatGptModel({
        modelId: "subscription-slug",
        getAccessToken: async () => "token",
        fetch: async () => sse([...events("partial", false), event]),
      });
      await assert.rejects(
        async () => model.doGenerate({ prompt }),
        /insufficient_quota: Subscription quota exhausted|subscription_disabled: Subscription authorization disabled/,
      );
    }
  });

  it("rejects malformed completion and incomplete local tool calls", async () => {
    for (const event of [
      {
        type: "response.completed",
        response: { status: "incomplete", usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", status: "incomplete" },
      },
    ]) {
      const model = createChatGptModel({
        modelId: "subscription-slug",
        getAccessToken: async () => "token",
        fetch: async () => sse([event]),
      });
      await assert.rejects(
        async () => model.doGenerate({ prompt }),
        /missing a successful status|incomplete local function call/,
      );
    }
  });

  it("cancels promptly while token refresh remains pending", async () => {
    const abort = new AbortController();
    let releaseToken: (token: string) => void = () => {};
    let requests = 0;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () =>
        new Promise<string>((resolve) => {
          releaseToken = resolve;
        }),
      fetch: async () => {
        requests++;
        return sse(events());
      },
    });
    const result = Promise.resolve(model.doGenerate({ prompt, abortSignal: abort.signal }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort(new Error("cancel refresh wait"));
    await assert.rejects(result, /cancel refresh wait/);
    releaseToken("rotated token");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
  });

  it("propagates mid-stream abort to the active HTTP stream", async () => {
    const abort = new AbortController();
    let cancelled = false;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async (_url, init) => {
        const bytes = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                cancelled = true;
                controller.error(init.signal?.reason);
              },
              { once: true },
            );
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(events("partial", false)[0])}\n\n`),
            );
          },
        });
        return new Response(bytes, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const result = Promise.resolve(model.doGenerate({ prompt, abortSignal: abort.signal }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reason = new Error("cancel active HTTP");
    abort.abort(reason);
    await assert.rejects(result, (error: unknown) => {
      assert.ok(APICallError.isInstance(error));
      assert.equal(error.cause, reason);
      return true;
    });
    assert.equal(cancelled, true);
  });

  it("honors abort while token refresh is pending without sending HTTP", async () => {
    const abort = new AbortController();
    let requests = 0;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => {
        abort.abort(new Error("fixture canceled"));
        return "token";
      },
      fetch: async () => {
        requests++;
        return sse(events());
      },
    });
    await assert.rejects(
      async () => model.doGenerate({ prompt, abortSignal: abort.signal }),
      /fixture canceled/,
    );
    assert.equal(requests, 0);
  });

  it("rejects hosted tools before token or HTTP access", async () => {
    let tokenReads = 0;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => {
        tokenReads++;
        return "token";
      },
    });
    await assert.rejects(
      async () =>
        model.doGenerate({
          prompt,
          tools: [{ type: "provider", id: "openai.web_search", name: "web_search", args: {} }],
        }),
      /local function tools only/,
    );
    assert.equal(tokenReads, 0);
  });

  it("defaults omitted function strict to false while preserving explicit true/false and roll namespace in generateText, streamText and AgentSession", async () => {
    const scheduleTools = buildScheduleToolset(
      {
        sessionCwd: process.cwd(),
        port: {
          captureCreate: () => {
            throw new Error("must not call admission");
          },
          create: () => {
            throw new Error("must not create schedule");
          },
          list: () => {
            throw new Error("must not list schedules");
          },
        },
      },
      new ToolRegistry(),
      { requestApproval: async () => ({ approved: false }) },
    );
    const mcpBuilt = buildAgentToolset(
      [
        {
          agentName: "mcp",
          client: { callTool: async () => ({ content: [] }) },
          tools: [
            {
              tool: {
                name: "search",
                description: "MCP search with optional paging",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    cursor: { type: "string" },
                    limit: { type: "integer", minimum: 1, maximum: 20 },
                  },
                  required: ["query"],
                  additionalProperties: false,
                },
              },
              annotations: undefined,
            },
          ],
        },
      ],
      { requestApproval: async () => ({ approved: false }) },
      new ToolRegistry(),
    );
    const explicitFalseTool = tool({
      description: "Explicit non-strict tool",
      inputSchema: z.object({ q: z.string(), page: z.number().int().optional() }).strict(),
      strict: false,
      execute: async () => "ok",
    });
    const tools = {
      ...mcpBuilt.tools,
      ...scheduleTools.createTools,
      ...scheduleTools.listTools,
      explicit_non_strict: explicitFalseTool,
    };

    const capturedBodies: unknown[] = [];
    const model = createChatGptModel({
      modelId: "gpt-5.4",
      getAccessToken: async () => "fixture-token",
      fetch: async (url, init) => {
        assert.equal(String(url), "https://api.openai.com/v1/responses");
        capturedBodies.push(JSON.parse(String(init?.body)));
        return sse(events("ok"));
      },
    });

    const genResult = await generateText({ model, prompt: "probe", tools });
    assert.equal(genResult.text, "ok");

    const streamResult = streamText({ model, prompt: "probe", tools });
    assert.equal(await streamResult.text, "ok");

    const session = new AgentSession({
      id: "chatgpt-transcript-wire",
      model,
      sources: [],
      maxSteps: 2,
      readCheckpointTranscript: () => {
        throw new Error("must not read transcript during wire schema probe");
      },
    });
    try {
      for await (const event of session.send("hello")) {
        if (event.type === "error") throw new Error(event.message);
      }
    } finally {
      await session.close();
    }

    assert.equal(capturedBodies.length, 3);
    for (const body of capturedBodies.slice(0, 2)) {
      assert.ok(isRecord(body) && Array.isArray(body.tools));
      assert.equal(body.tools.length, 1);
      const ns = body.tools[0];
      assert.ok(isRecord(ns));
      assert.equal(ns.type, "namespace");
      assert.equal(ns.name, "roll");
      assert.equal(
        ns.description,
        "Local tools executed by Roll with its existing approval policy.",
      );
      assert.ok(Array.isArray(ns.tools));

      const byName = new Map<string, Record<string, unknown>>();
      for (const entry of ns.tools) {
        assert.ok(isRecord(entry) && entry.type === "function" && typeof entry.name === "string");
        byName.set(entry.name, entry);
      }

      const mcpWire = byName.get("mcp__search");
      assert.ok(mcpWire);
      assert.equal(mcpWire.strict, false);
      assert.ok(isRecord(mcpWire.parameters));
      assert.deepEqual(mcpWire.parameters.required, ["query"]);

      const scheduleListWire = byName.get("roll__schedule_list");
      assert.ok(scheduleListWire);
      assert.equal(scheduleListWire.strict, false);

      const scheduleCreateWire = byName.get(SCHEDULE_CREATE_TOOL_ID);
      assert.ok(scheduleCreateWire);
      assert.equal(scheduleCreateWire.strict, true);

      const explicitFalseWire = byName.get("explicit_non_strict");
      assert.ok(explicitFalseWire);
      assert.equal(explicitFalseWire.strict, false);
    }

    const sessionBody = capturedBodies[2];
    assert.ok(isRecord(sessionBody) && Array.isArray(sessionBody.tools));
    const sessionNs = sessionBody.tools[0];
    assert.ok(isRecord(sessionNs) && Array.isArray(sessionNs.tools));
    const transcriptWire = sessionNs.tools.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.type === "function" && entry.name === "roll__transcript",
    );
    assert.ok(transcriptWire);
    assert.equal(transcriptWire.strict, false);
    assert.ok(isRecord(transcriptWire.parameters));
    assert.deepEqual(transcriptWire.parameters.required, ["checkpointId"]);
  });

  it("omits foreign empty signature text parts when replaying history through ChatGPT", async () => {
    let capturedBody: unknown;
    const model = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "token",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return sse(events("ok"));
      },
    });
    const result = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "",
              providerOptions: { google: { thoughtSignature: "sig-r" } },
            },
            { type: "text", text: "Hello" },
            { type: "text", text: "", providerOptions: { google: { thoughtSignature: "sig" } } },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "",
              providerOptions: { google: { thoughtSignature: "sig-r-only" } },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ],
    });
    await result.stream.cancel();
    assert.ok(isRecord(capturedBody) && Array.isArray(capturedBody.input));
    const assistantItems = capturedBody.input.filter(
      (item: unknown): item is Record<string, unknown> =>
        isRecord(item) && item.role === "assistant",
    );
    assert.deepEqual(
      assistantItems.map((item) => item.content),
      ["Hello"],
    );
  });

  it("does not leak subscription-local rs/msg item_reference when switching from ChatGPT to OpenAI API", async () => {
    const reasoning = {
      type: "reasoning",
      id: "rs-private-subscription",
      encrypted_content: "pretend-private-encrypted-reasoning",
    };
    const item = { type: "message", id: "msg-subscription" };
    const frames = [
      {
        type: "response.created",
        response: { id: "resp-fixture", created_at: 1700000000, model: "subscription-slug" },
      },
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item },
      { type: "response.output_text.delta", item_id: item.id, output_index: 1, delta: "answer" },
      { type: "response.output_item.done", output_index: 1, item },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 4, output_tokens: 3 } },
      },
    ];

    let subReq: unknown;
    let apiReq: unknown;
    const originalFetch = globalThis.fetch;
    const subModel = createChatGptModel({
      modelId: "subscription-slug",
      getAccessToken: async () => "fixture",
      fetch: async (_url, init) => {
        subReq = JSON.parse(String(init?.body));
        return sse(frames);
      },
    });
    globalThis.fetch = async (_url, init) => {
      apiReq = JSON.parse(String(init?.body));
      return new Response("fixture stop", { status: 400 });
    };

    const session = new AgentSession({
      id: "cross-chatgpt-to-openai-api",
      model: subModel,
      retainEmptyReasoningPart: shouldRetainEmptyReasoningPart,
      sources: [],
      maxSteps: 1,
    });
    try {
      const firstEvents: unknown[] = [];
      for await (const event of session.send("first")) {
        firstEvents.push(event);
      }
      assert.ok(firstEvents.length > 0);
      assert.ok(isRecord(subReq));
      assert.equal(subReq.store, false);
      assert.equal(
        session
          .getMessages()
          .filter((message) => message.role === "assistant")
          .some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "reasoning"),
          ),
        false,
      );

      session.switchModel({ model: createProviderModel("openai", "gpt-5.4", "fixture") });
      const nextEvents: unknown[] = [];
      for await (const event of session.send("next")) {
        nextEvents.push(event);
      }
      assert.ok(nextEvents.length > 0);
      assert.ok(isRecord(apiReq) && Array.isArray(apiReq.input));
      assert.deepEqual(
        apiReq.input.filter(
          (entry: unknown) =>
            isRecord(entry) && (entry.type === "item_reference" || entry.type === "reasoning"),
        ),
        [],
      );
      assert.equal(
        apiReq.input.some(
          (entry: unknown) =>
            isRecord(entry) &&
            entry.role === "assistant" &&
            JSON.stringify(entry.content).includes("answer"),
        ),
        true,
      );
    } finally {
      await session.close();
      globalThis.fetch = originalFetch;
    }
  });
});
