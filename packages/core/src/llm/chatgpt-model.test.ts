import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, Output } from "ai";
import { z } from "zod";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createChatGptModel } from "./chatgpt-model.ts";
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
});
