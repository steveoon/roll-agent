import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateText, streamText, tool } from "ai";
import { z } from "zod";
import {
  AgentSession,
  buildAgentToolset,
  buildScheduleToolset,
  SCHEDULE_CREATE_TOOL_ID,
  ToolRegistry,
} from "@roll-agent/runtime";
import {
  createProviderModel,
  providerAcceptsToolSchemaIssues,
  resolveLLMCall,
  shouldRetainEmptyReasoningPart,
  thinkingProviderOptions,
  UnsupportedThinkingLevelError,
} from "./providers.ts";
import { apiSamplingThinkingLevel } from "./thinking-levels.ts";
import { inlineAcyclicLocalJsonSchemaReferences } from "../tool-runtime/json-schema-refs.ts";
import type { LanguageModelV4 } from "@ai-sdk/provider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("createProviderModel", () => {
  it("should create an anthropic model", () => {
    const model = createProviderModel("anthropic", "claude-sonnet-4-6", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "claude-sonnet-4-6");
  });

  for (const strict of [undefined, false, true]) {
    it(`Anthropic adapts only strict function tools (strict: ${strict})`, async () => {
      const originalFetch = globalThis.fetch;
      const schema = {
        type: "object" as const,
        properties: { name: { type: "string" as const, maxLength: 10 } },
        required: ["name"],
        additionalProperties: false,
      };
      let captured = false;
      try {
        globalThis.fetch = async (_url, init) => {
          const body: unknown = JSON.parse(String(init?.body));
          assert.ok(isRecord(body) && Array.isArray(body.tools));
          const wire: unknown = body.tools[0];
          assert.ok(isRecord(wire));
          assert.equal(wire.strict, strict);
          assert.deepEqual(
            wire.input_schema,
            strict === true
              ? {
                  ...schema,
                  properties: {
                    name: { type: "string", description: "Constraints: maxLength=10." },
                  },
                }
              : schema,
          );
          captured = true;
          return new Response("", { headers: { "content-type": "text/event-stream" } });
        };
        const model = createProviderModel("anthropic", "claude-sonnet-5", "fixture-key");
        const result = await model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
          tools: [
            {
              type: "function",
              name: "probe",
              inputSchema: schema,
              ...(strict === undefined ? {} : { strict }),
            },
          ],
        });
        await result.stream.cancel();
        assert.equal(captured, true);
        assert.equal(schema.properties.name.maxLength, 10);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  it("should create an openai model", () => {
    const model = createProviderModel("openai", "gpt-5.5", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "gpt-5.5");
  });

  it("OpenAI Responses defaults omitted function tool strict to false while preserving explicit true/false and provider tools", async () => {
    const scheduleRegistry = new ToolRegistry();
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
      scheduleRegistry,
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

    const originalFetch = globalThis.fetch;
    const capturedBodies: unknown[] = [];
    try {
      globalThis.fetch = async (url, init) => {
        assert.match(String(url), /\/responses$/u);
        const parsed: unknown = JSON.parse(String(init?.body));
        capturedBodies.push(parsed);
        if (isRecord(parsed) && parsed.stream === true) {
          const chunks = [
            {
              type: "response.created",
              response: { id: "resp_stream", created_at: 1, model: "gpt-5.4" },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_stream",
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            },
            {
              type: "response.output_text.delta",
              item_id: "msg_stream",
              output_index: 0,
              content_index: 0,
              delta: "ok",
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_stream",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_stream",
                created_at: 1,
                model: "gpt-5.4",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ];
          return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({
          id: "resp_gen",
          created_at: 1,
          model: "gpt-5.4",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_gen",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      };

      const model = createProviderModel("openai", "gpt-5.4", "fixture-key");
      const genResult = await generateText({ model, prompt: "probe", tools });
      assert.equal(genResult.text, "ok");

      const streamResult = streamText({ model, prompt: "probe", tools });
      assert.equal(await streamResult.text, "ok");

      const session = new AgentSession({
        id: "openai-transcript-wire",
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

      const rawCallTools = [
        {
          type: "function" as const,
          name: "omitted_fn",
          inputSchema: {
            type: "object" as const,
            properties: { id: { type: "string" as const } },
            required: ["id"],
            additionalProperties: false,
          },
        },
        {
          type: "provider" as const,
          id: "openai.web_search" as const,
          name: "web_search",
          args: {},
        },
      ];
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
        tools: rawCallTools,
      });
      const providerStream = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
        tools: rawCallTools,
      });
      await providerStream.stream.cancel();

      assert.equal(capturedBodies.length, 5);
      for (const body of capturedBodies.slice(0, 2)) {
        assert.ok(isRecord(body) && Array.isArray(body.tools));
        const byKey = new Map<string, Record<string, unknown>>();
        for (const entry of body.tools) {
          assert.ok(isRecord(entry) && typeof entry.type === "string");
          const key = entry.type === "function" ? String(entry.name) : entry.type;
          byKey.set(key, entry);
        }

        const mcpWire = byKey.get("mcp__search");
        assert.ok(mcpWire);
        assert.equal(mcpWire.strict, false);
        assert.ok(isRecord(mcpWire.parameters));
        assert.deepEqual(mcpWire.parameters.required, ["query"]);

        const scheduleListWire = byKey.get("roll__schedule_list");
        assert.ok(scheduleListWire);
        assert.equal(scheduleListWire.strict, false);

        const scheduleCreateWire = byKey.get(SCHEDULE_CREATE_TOOL_ID);
        assert.ok(scheduleCreateWire);
        assert.equal(scheduleCreateWire.strict, true);

        const explicitFalseWire = byKey.get("explicit_non_strict");
        assert.ok(explicitFalseWire);
        assert.equal(explicitFalseWire.strict, false);
      }

      const sessionBody = capturedBodies[2];
      assert.ok(isRecord(sessionBody) && Array.isArray(sessionBody.tools));
      const transcriptWire = sessionBody.tools.find(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) && entry.type === "function" && entry.name === "roll__transcript",
      );
      assert.ok(transcriptWire);
      assert.equal(transcriptWire.strict, false);
      assert.ok(isRecord(transcriptWire.parameters));
      assert.deepEqual(transcriptWire.parameters.required, ["checkpointId"]);

      for (const providerBody of capturedBodies.slice(3, 5)) {
        assert.ok(isRecord(providerBody) && Array.isArray(providerBody.tools));
        assert.deepEqual(providerBody.tools, [
          {
            type: "function",
            name: "omitted_fn",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
            strict: false,
          },
          { type: "web_search" },
        ]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should create a deepseek model", () => {
    const model = createProviderModel("deepseek", "deepseek-v4-flash", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "deepseek-v4-flash");
  });

  for (const method of ["doGenerate", "doStream"] as const) {
    it(`preserves deepseek-flash reasoning across user turns in ${method}`, async () => {
      const originalFetch = globalThis.fetch;
      let capturedBody: unknown;
      try {
        globalThis.fetch = async (_url, init) => {
          assert.equal(typeof init?.body, "string");
          capturedBody = JSON.parse(String(init?.body));
          return method === "doStream"
            ? new Response("", { headers: { "content-type": "text/event-stream" } })
            : Response.json({
                id: "flash-response",
                created: 0,
                model: "deepseek-flash",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              });
        };
        const model = createProviderModel("deepseek", "deepseek-flash", "test-key");
        const result = await model[method]({
          prompt: [
            { role: "user", content: [{ type: "text", text: "first" }] },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "fixture reasoning" },
                { type: "text", text: "first answer" },
              ],
            },
            { role: "user", content: [{ type: "text", text: "second" }] },
            { role: "assistant", content: [{ type: "text", text: "imported answer" }] },
            { role: "user", content: [{ type: "text", text: "third" }] },
          ],
          tools: [{ type: "function", name: "probe", inputSchema: { type: "object" } }],
          providerOptions: { deepseek: { thinking: { type: "enabled" } } },
        });
        if ("stream" in result) await result.stream.cancel();
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.ok(isRecord(capturedBody));
      assert.equal(capturedBody.model, "deepseek-flash");
      assert.ok(Array.isArray(capturedBody.messages));
      const messages: unknown[] = capturedBody.messages;
      assert.deepEqual(
        messages.filter((message) => isRecord(message) && message.role === "assistant"),
        [
          { role: "assistant", content: "first answer", reasoning_content: "fixture reasoning" },
          { role: "assistant", content: "imported answer", reasoning_content: "" },
        ],
      );
    });
  }

  it("preserves explicit DeepSeek beta strict mode and tool schemas", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: unknown;
    let capturedUrl: string | undefined;
    const schema = {
      type: "object" as const,
      properties: { value: { type: "string" as const } },
      required: ["value"],
      additionalProperties: false,
    };
    try {
      globalThis.fetch = async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body));
        return new Response("", { headers: { "content-type": "text/event-stream" } });
      };
      const result = await createProviderModel(
        "deepseek",
        "deepseek-flash",
        "test-key",
        "https://api.deepseek.com/beta/",
      ).doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
        tools: [{ type: "function", name: "probe", inputSchema: schema, strict: true }],
      });
      await result.stream.cancel();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(capturedUrl, "https://api.deepseek.com/beta/chat/completions");
    assert.ok(isRecord(capturedBody));
    assert.deepEqual(capturedBody.tools, [
      {
        type: "function",
        function: { name: "probe", parameters: schema, strict: true },
      },
    ]);
  });

  it("forwards DeepSeek vision attachments as image_url content", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: unknown;

    try {
      globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body);

        return new Response(
          JSON.stringify({
            id: "vision-response",
            created: 0,
            model: "deepseek-v4-flash-vision-exp",
            choices: [
              {
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      await generateText({
        model: createProviderModel("deepseek", "deepseek-v4-flash-vision-exp", "test-key"),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "描述图片" },
              { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
            ],
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(isRecord(capturedBody));
    assert.deepEqual(capturedBody.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "描述图片" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
    ]);
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

  it("should create a google gemini model", () => {
    const model = createProviderModel("google", "gemini-3.7-flash", "test-key");
    assert.ok(model);
    assert.equal(model.modelId, "gemini-3.7-flash");
    assert.equal(model.provider, "google.generative-ai");
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
  it("keeps qwen thinking disabled for structured-output calls at every level", () => {
    for (const level of ["off", "low", "medium", "high"] as const) {
      const resolved = resolveLLMCall(
        "qwen",
        "qwen3.6-plus",
        "test-key",
        "structured-output",
        undefined,
        level,
      );

      assert.equal(resolved.model.modelId, "qwen3.6-plus");
      assert.equal(resolved.reasoning, undefined);
      assert.deepEqual(resolved.providerOptions, {
        alibaba: {
          enableThinking: false,
        },
      });
    }
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
      xai: { reasoningEffort: "medium" },
    });
  });

  it("applies the requested thinking level for chat calls", () => {
    const off = resolveLLMCall("qwen", "qwen3.7-plus", "k", "chat", undefined, "off");
    assert.deepEqual(off.providerOptions, { alibaba: { enableThinking: false } });
    const high = resolveLLMCall("anthropic", "claude-sonnet-4-6", "k", "chat", undefined, "high");
    assert.deepEqual(high.providerOptions, {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    });
  });

  it("uses AI SDK unified reasoning for structured-output calls across providers", () => {
    const providers = [
      { provider: "openai", model: "gpt-5.4" },
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "xai", model: "grok-4.5" },
      { provider: "google", model: "gemini-3.7-flash" },
    ] as const;

    for (const { provider, model } of providers) {
      const defaultResolved = resolveLLMCall(provider, model, "test-key", "structured-output");
      assert.equal(defaultResolved.reasoning, "medium", `${provider} default reasoning`);
      assert.equal(defaultResolved.providerOptions, undefined, `${provider} providerOptions`);

      for (const level of ["low", "medium", "high"] as const) {
        const resolved = resolveLLMCall(
          provider,
          model,
          "test-key",
          "structured-output",
          undefined,
          level,
        );
        assert.equal(resolved.model.modelId, model);
        assert.equal(resolved.reasoning, level, `${provider} ${level} reasoning`);
        assert.equal(resolved.providerOptions, undefined, `${provider} ${level} providerOptions`);
      }
    }
  });

  it("maps supported structured-output off levels and omits reasoning for non-reasoning OpenAI", () => {
    const supported = [
      { provider: "openai", model: "gpt-5.5" },
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "xai", model: "grok-4.3" },
      { provider: "google", model: "gemini-3.7-flash" },
      { provider: "google", model: "gemini-2.5-flash" },
    ] as const;

    for (const { provider, model } of supported) {
      const resolved = resolveLLMCall(
        provider,
        model,
        "test-key",
        "structured-output",
        undefined,
        "off",
      );
      assert.equal(resolved.reasoning, "none", `${provider} off reasoning`);
      assert.equal(resolved.providerOptions, undefined, `${provider} off providerOptions`);
    }

    for (const model of ["gpt-4.1", "gpt-5-chat-latest"] as const) {
      for (const level of ["off", "low", "medium", "high"] as const) {
        const nonReasoning = resolveLLMCall(
          "openai",
          model,
          "test-key",
          "structured-output",
          undefined,
          level,
        );
        assert.equal(nonReasoning.reasoning, undefined, `${model} ${level}`);
        assert.equal(nonReasoning.providerOptions, undefined, `${model} ${level}`);
      }
    }
  });

  it("fails fast when OpenAI or xAI structured output cannot disable reasoning", () => {
    for (const model of ["gpt-5", "o3"] as const) {
      assert.throws(
        () => resolveLLMCall("openai", model, "test-key", "structured-output", undefined, "off"),
        (error: Error) =>
          error.message.includes(`OpenAI model "${model}" cannot disable reasoning`),
      );
    }

    for (const model of [
      "grok-4.5",
      "grok-4.6",
      "grok-4.7",
      "grok-4.20-reasoning",
      "grok-4.20-beta-0309-reasoning",
      "grok-4.20-beta-latest",
      "grok-4.20-reasoning-gv2",
      "grok-4.20-multi-agent",
    ] as const) {
      assert.throws(
        () => resolveLLMCall("xai", model, "test-key", "structured-output", undefined, "off"),
        (error: Error) =>
          error.message.includes(`模型 ${model} 不支持关闭思考`) &&
          error.message.includes("runtime.compaction.thinking-level"),
      );
    }
  });

  it("fails fast when Gemini 2.5 Pro structured output cannot disable reasoning", () => {
    assert.throws(
      () =>
        resolveLLMCall(
          "google",
          "gemini-2.5-pro",
          "test-key",
          "structured-output",
          undefined,
          "off",
        ),
      (error: Error) =>
        error.message.includes('Google model "gemini-2.5-pro" cannot disable reasoning'),
    );
  });

  it("omits effort for fixed xAI grok-4.20 aliases", () => {
    const fixedReasoningAliases = [
      "grok-4.20",
      "grok-4.20-0309-reasoning",
      "grok-4.20-beta-0309-reasoning",
      "grok-4.20-beta-latest-reasoning",
      "grok-4.20-reasoning-gv2",
    ] as const;
    for (const model of fixedReasoningAliases) {
      const resolved = resolveLLMCall(
        "xai",
        model,
        "test-key",
        "structured-output",
        undefined,
        "medium",
      );
      assert.equal(resolved.reasoning, undefined, model);
      assert.equal(resolved.providerOptions, undefined, model);
    }

    for (const model of [
      "grok-4.20-non-reasoning",
      "grok-4.20-beta-0309-non-reasoning",
      "grok-4.20-non-reasoning-gv2",
    ] as const) {
      for (const level of ["off", "medium"] as const) {
        const resolved = resolveLLMCall(
          "xai",
          model,
          "test-key",
          "structured-output",
          undefined,
          level,
        );
        assert.equal(resolved.reasoning, undefined, `${model} ${level}`);
        assert.equal(resolved.providerOptions, undefined, `${model} ${level}`);
      }
    }
  });

  it("keeps chat and sampling on provider-specific thinking options", () => {
    const cases = [
      {
        provider: "openai",
        model: "gpt-5.4",
        expected: { openai: { reasoningEffort: "high" } },
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        expected: {
          anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
        },
      },
      {
        provider: "qwen",
        model: "qwen3.7-plus",
        expected: { alibaba: { enableThinking: true, thinkingBudget: 16_384 } },
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        expected: { deepseek: { thinking: { type: "enabled" } } },
      },
      {
        provider: "xai",
        model: "grok-4.5",
        expected: { xai: { reasoningEffort: "high" } },
      },
      {
        provider: "google",
        model: "gemini-3.7-flash",
        expected: { google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } },
      },
    ] as const;

    for (const purpose of ["chat", "sampling"] as const) {
      for (const { provider, model, expected } of cases) {
        const resolved = resolveLLMCall(provider, model, "test-key", purpose, undefined, "high");
        assert.equal(resolved.reasoning, undefined, `${provider} ${purpose} reasoning`);
        assert.deepEqual(resolved.providerOptions, expected, `${provider} ${purpose} options`);
      }
    }
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
    // The pinned xAI adapter serializes only the supported effort setting.
    assert.deepEqual(capturedBody.reasoning, { effort: "medium" });
  });

  it("serializes Gemini thinking config through generateContent", async () => {
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

      const resolved = resolveLLMCall("google", "gemini-3.7-flash", "test-key", "chat");
      const result = await resolved.model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
      });
      await result.stream.cancel();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(capturedUrl?.includes("/models/gemini-3.7-flash:streamGenerateContent"), capturedUrl);
    assert.ok(isRecord(capturedBody));
    assert.ok(isRecord(capturedBody.generationConfig));
    assert.deepEqual(capturedBody.generationConfig.thinkingConfig, {
      thinkingLevel: "medium",
      includeThoughts: true,
    });
  });

  it("serializes identical native thinkingLevel for bare and models/-prefixed Gemini 4 targets", async () => {
    const originalFetch = globalThis.fetch;

    async function captureRequest(
      modelName: string,
      purpose: "chat" | "sampling" | "structured-output",
      level: "low" | "high" | "xhigh",
      baseURL?: string,
    ): Promise<{ url: string; thinkingConfig: unknown }> {
      let capturedUrl: string | undefined;
      let capturedBody: unknown;
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

      const resolved = resolveLLMCall("google", modelName, "test-key", purpose, baseURL, level);
      const result = await resolved.model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
        ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
      });
      await result.stream.cancel();

      assert.ok(capturedUrl);
      assert.ok(isRecord(capturedBody) && isRecord(capturedBody.generationConfig));
      return { url: capturedUrl, thinkingConfig: capturedBody.generationConfig.thinkingConfig };
    }

    try {
      for (const base of ["gemini-4-neon", "gemini-4-hydrogen"] as const) {
        for (const purpose of ["chat", "sampling", "structured-output"] as const) {
          for (const level of ["low", "xhigh"] as const) {
            const bare = await captureRequest(base, purpose, level);
            const prefixed = await captureRequest(`models/${base}`, purpose, level);
            assert.equal(prefixed.url, bare.url, `${base} ${purpose} ${level} URL parity`);
            assert.ok(bare.url.includes(`/models/${base}:streamGenerateContent`), bare.url);
            const expected =
              purpose === "structured-output"
                ? { thinkingLevel: level }
                : { thinkingLevel: level, includeThoughts: true };
            assert.deepEqual(bare.thinkingConfig, expected, `${base} ${purpose} ${level}`);
            assert.deepEqual(
              prefixed.thinkingConfig,
              expected,
              `models/${base} ${purpose} ${level}`,
            );
          }
        }
      }

      for (const base of ["gemini-4-carbon", "gemini-4-argon"] as const) {
        for (const purpose of ["chat", "sampling", "structured-output"] as const) {
          for (const level of ["low", "high"] as const) {
            const bare = await captureRequest(base, purpose, level);
            const prefixed = await captureRequest(`models/${base}`, purpose, level);
            assert.equal(prefixed.url, bare.url, `${base} ${purpose} ${level} URL parity`);
            const expected =
              purpose === "structured-output"
                ? { thinkingLevel: level }
                : { thinkingLevel: level, includeThoughts: true };
            assert.deepEqual(bare.thinkingConfig, expected, `${base} ${purpose} ${level}`);
            assert.deepEqual(
              prefixed.thinkingConfig,
              expected,
              `models/${base} ${purpose} ${level}`,
            );
          }
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("matches only the terminal segment on full Google resource paths with custom baseURL", async () => {
    const originalFetch = globalThis.fetch;
    const customBaseURL = "https://custom-google.example/v1beta";
    const neonProjectCarbon =
      "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-4-carbon";
    const neonProjectLegacy =
      "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-2.5-flash";
    const carbonProjectNeon =
      "projects/gemini-4-carbon-prod/locations/global/publishers/google/models/gemini-4-neon";

    let fetchCalls = 0;
    const captured: Array<{ url: string; thinkingConfig: unknown }> = [];
    try {
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        fetchCalls += 1;
        const url = input instanceof Request ? input.url : String(input);
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        const body: unknown = JSON.parse(init.body);
        assert.ok(isRecord(body) && isRecord(body.generationConfig));
        captured.push({ url, thinkingConfig: body.generationConfig.thinkingConfig });
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      for (const purpose of ["chat", "sampling", "structured-output", "text"] as const) {
        for (const unsupported of ["off", "xhigh", "max"] as const) {
          assert.throws(
            () =>
              resolveLLMCall(
                "google",
                neonProjectCarbon,
                "test-key",
                purpose,
                customBaseURL,
                unsupported,
              ),
            UnsupportedThinkingLevelError,
          );
        }
        assert.throws(
          () =>
            resolveLLMCall(
              "google",
              neonProjectLegacy,
              "test-key",
              purpose,
              customBaseURL,
              "xhigh",
            ),
          UnsupportedThinkingLevelError,
        );
        assert.throws(
          () =>
            resolveLLMCall("google", carbonProjectNeon, "test-key", purpose, customBaseURL, "off"),
          UnsupportedThinkingLevelError,
        );
      }
      assert.equal(fetchCalls, 0, "rejected full resource paths must not issue HTTP requests");

      const legacyLow = resolveLLMCall(
        "google",
        neonProjectLegacy,
        "test-key",
        "chat",
        customBaseURL,
        "low",
      );
      await (
        await legacyLow.model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
          ...(legacyLow.providerOptions ? { providerOptions: legacyLow.providerOptions } : {}),
        })
      ).stream.cancel();

      const carbonLow = resolveLLMCall(
        "google",
        neonProjectCarbon,
        "test-key",
        "chat",
        customBaseURL,
        "low",
      );
      await (
        await carbonLow.model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
          ...(carbonLow.providerOptions ? { providerOptions: carbonLow.providerOptions } : {}),
        })
      ).stream.cancel();

      for (const purpose of ["chat", "sampling", "structured-output"] as const) {
        const neonXhigh = resolveLLMCall(
          "google",
          carbonProjectNeon,
          "test-key",
          purpose,
          customBaseURL,
          "xhigh",
        );
        await (
          await neonXhigh.model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
            ...(neonXhigh.providerOptions ? { providerOptions: neonXhigh.providerOptions } : {}),
            ...(neonXhigh.reasoning ? { reasoning: neonXhigh.reasoning } : {}),
          })
        ).stream.cancel();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(captured.length, 5);
    assert.equal(
      captured[0]?.url,
      `${customBaseURL}/${neonProjectLegacy}:streamGenerateContent?alt=sse`,
    );
    assert.deepEqual(captured[0]?.thinkingConfig, {
      thinkingBudget: 2048,
      includeThoughts: true,
    });
    assert.equal(
      captured[1]?.url,
      `${customBaseURL}/${neonProjectCarbon}:streamGenerateContent?alt=sse`,
    );
    assert.deepEqual(captured[1]?.thinkingConfig, {
      thinkingLevel: "low",
      includeThoughts: true,
    });
    assert.equal(
      captured[2]?.url,
      `${customBaseURL}/${carbonProjectNeon}:streamGenerateContent?alt=sse`,
    );
    assert.deepEqual(captured[2]?.thinkingConfig, {
      thinkingLevel: "xhigh",
      includeThoughts: true,
    });
    assert.deepEqual(captured[3]?.thinkingConfig, {
      thinkingLevel: "xhigh",
      includeThoughts: true,
    });
    assert.deepEqual(captured[4]?.thinkingConfig, {
      thinkingLevel: "xhigh",
    });
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
    assert.deepEqual(thinkingProviderOptions("openai", "gpt-5.5", "off"), {
      openai: { reasoningEffort: "none" },
    });
  });

  it("maps anthropic 4.6+ thinking to adaptive effort", () => {
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-4-6", "low"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-opus-5-0", "high"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-5", "medium"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-fable-5", "high"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    });
    assert.deepEqual(thinkingProviderOptions("anthropic", "claude-sonnet-5-20260601", "low"), {
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
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

  it("maps xAI reasoning effort and rejects off on models that require reasoning", () => {
    for (const model of ["grok-4.5", "grok-4.6", "grok-4.7"]) {
      assert.throws(
        () => thinkingProviderOptions("xai", model, "off"),
        /不支持关闭思考。请将 runtime\.thinking-level 设为 low/u,
      );
    }
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.5", "low"), {
      xai: { reasoningEffort: "low" },
    });
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.5", "medium"), {
      xai: { reasoningEffort: "medium" },
    });
    assert.deepEqual(thinkingProviderOptions("xai", "grok-4.5", "high"), {
      xai: { reasoningEffort: "high" },
    });
  });

  it("respects xAI models with fixed or disabled reasoning", () => {
    assert.equal(thinkingProviderOptions("xai", "grok-4.20-non-reasoning", "high"), undefined);
    assert.equal(
      thinkingProviderOptions("xai", "grok-4.20-beta-0309-non-reasoning", "high"),
      undefined,
    );
    assert.equal(thinkingProviderOptions("xai", "grok-4.20-reasoning", "off"), undefined);
    assert.equal(thinkingProviderOptions("xai", "grok-4.20-reasoning", "medium"), undefined);
    assert.equal(
      thinkingProviderOptions("xai", "grok-4.20-beta-latest-reasoning", "medium"),
      undefined,
    );
    assert.equal(thinkingProviderOptions("xai", "grok-3", "medium"), undefined);
  });

  it("treats deepseek effort levels as on-only (no effort granularity)", () => {
    const enabled = { deepseek: { thinking: { type: "enabled" } } };
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "low"), enabled);
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "medium"), enabled);
    assert.deepEqual(thinkingProviderOptions("deepseek", "deepseek-reasoner", "high"), enabled);
  });

  it("maps Gemini 3 thinking levels and surfaces thought summaries", () => {
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.7-flash", "low"), {
      google: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.7-flash", "medium"), {
      google: { thinkingConfig: { thinkingLevel: "medium", includeThoughts: true } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.1-pro-preview", "high"), {
      google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
    });
  });

  it("maps Gemini 4 thinking tiers independently for Neon/Hydrogen vs Carbon/Argon", () => {
    for (const model of [
      "gemini-4-hydrogen",
      "gemini-4-neon",
      "models/gemini-4-neon",
      "gemini-4-neon-preview",
    ]) {
      for (const level of ["low", "medium", "high", "xhigh"] as const) {
        assert.deepEqual(thinkingProviderOptions("google", model, level), {
          google: { thinkingConfig: { thinkingLevel: level, includeThoughts: true } },
        });
      }
      for (const unsupported of ["off", "max"] as const) {
        assert.throws(
          () => thinkingProviderOptions("google", model, unsupported),
          (error: unknown) =>
            error instanceof UnsupportedThinkingLevelError && /不支持推理强度/.test(error.message),
        );
        for (const purpose of ["chat", "sampling", "structured-output", "text"] as const) {
          assert.throws(
            () => resolveLLMCall("google", model, "test-key", purpose, undefined, unsupported),
            (error: unknown) =>
              error instanceof UnsupportedThinkingLevelError &&
              /不支持推理强度/.test(error.message),
          );
        }
      }
    }
    for (const model of [
      "gemini-4-argon",
      "gemini-4-carbon",
      "models/gemini-4-carbon",
      "models/gemini-4-argon",
    ]) {
      for (const level of ["low", "medium", "high"] as const) {
        assert.deepEqual(thinkingProviderOptions("google", model, level), {
          google: { thinkingConfig: { thinkingLevel: level, includeThoughts: true } },
        });
      }
      for (const unsupported of ["off", "xhigh", "max"] as const) {
        assert.throws(
          () => thinkingProviderOptions("google", model, unsupported),
          (error: unknown) =>
            error instanceof UnsupportedThinkingLevelError && /不支持推理强度/.test(error.message),
        );
        for (const purpose of ["chat", "sampling", "structured-output", "text"] as const) {
          assert.throws(
            () => resolveLLMCall("google", model, "test-key", purpose, undefined, unsupported),
            (error: unknown) =>
              error instanceof UnsupportedThinkingLevelError &&
              /不支持推理强度/.test(error.message),
          );
        }
      }
    }
  });

  it("maps Gemini 3 off to the lowest thinking level each model accepts", () => {
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.1-pro-preview", "off"), {
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.5-flash", "off"), {
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.7-flash-lite", "off"), {
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.7-flash", "off"), {
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-3.8-flash-preview", "off"), {
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-flash-latest", "off"), {
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
  });

  it("maps Gemini 2.5 thinking to token budgets", () => {
    assert.deepEqual(thinkingProviderOptions("google", "gemini-2.5-flash", "medium"), {
      google: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-2.5-pro", "high"), {
      google: { thinkingConfig: { thinkingBudget: 16_384, includeThoughts: true } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-2.5-flash", "off"), {
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
    assert.deepEqual(thinkingProviderOptions("google", "gemini-2.5-pro", "off"), {
      google: { thinkingConfig: { thinkingBudget: 128 } },
    });
  });

  it("returns undefined for unknown providers", () => {
    assert.equal(thinkingProviderOptions("mystery", "model", "high"), undefined);
  });
});

describe("providerAcceptsToolSchemaIssues", () => {
  const recursiveRootDef = {
    path: "/properties/tree",
    ref: "#/$defs/node",
    reason: "recursive",
  } as const;
  const recursiveViaProperties = {
    path: "/properties/node",
    ref: "#/properties/node",
    reason: "recursive",
  } as const;
  const recursiveViaEncodedPath = {
    path: "/properties/node",
    ref: "#/$defs/a%2Fb",
    reason: "recursive",
  } as const;
  const unresolvable = {
    path: "/properties/x",
    ref: "#/properties/nope",
    reason: "unresolvable",
  } as const;
  const external = {
    path: "/properties/y",
    ref: "https://example.com/s.json#/x",
    reason: "external",
  } as const;

  it("lets google keep only leftovers it can pass through as root-level definition refs", () => {
    assert.equal(providerAcceptsToolSchemaIssues("google", []), true);
    assert.equal(providerAcceptsToolSchemaIssues("google", [recursiveRootDef]), true);
    assert.equal(providerAcceptsToolSchemaIssues("google", [recursiveViaProperties]), false);
    assert.equal(providerAcceptsToolSchemaIssues("google", [recursiveViaEncodedPath]), false);
    assert.equal(providerAcceptsToolSchemaIssues("google", [unresolvable]), false);
    assert.equal(providerAcceptsToolSchemaIssues("google", [external]), false);
    assert.equal(
      providerAcceptsToolSchemaIssues("google", [recursiveRootDef, unresolvable]),
      false,
    );
  });

  it("does not filter tools for providers that pass JSON Schema through", () => {
    for (const provider of ["openai", "anthropic", "deepseek", "qwen", "xai", "unknown"]) {
      assert.equal(
        providerAcceptsToolSchemaIssues(provider, [recursiveViaProperties, unresolvable, external]),
        true,
        provider,
      );
    }
  });
});

describe("tool schema compatibility after local ref inlining", () => {
  const rawSchema = {
    type: "object",
    properties: {
      locationCity: { type: "string", minLength: 1, description: "城市" },
      locationDistrict: { $ref: "#/properties/locationCity", description: "区" },
      major: { type: "array", items: { $ref: "#/properties/locationCity" }, minItems: 1 },
    },
  } as const;
  const inlined = inlineAcyclicLocalJsonSchemaReferences(rawSchema).schema;

  async function captureToolRequest(model: LanguageModelV4, schema: object): Promise<unknown> {
    const originalFetch = globalThis.fetch;
    let body: unknown;
    try {
      globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          {
            type: "function",
            name: "filter",
            description: "f",
            inputSchema: schema as never,
          },
        ],
      });
      await result.stream.cancel();
    } finally {
      globalThis.fetch = originalFetch;
    }
    return body;
  }

  it("Google receives fully inlined tool schemas from Roll", async () => {
    const model = createProviderModel("google", "gemini-3.8-flash", "k");
    const rawBody = await captureToolRequest(model, rawSchema);
    const body = await captureToolRequest(model, inlined);
    assert.ok(isRecord(body));
    // Newer Google providers pass these refs through, so Roll must still normalize them.
    assert.match(JSON.stringify(rawBody), /"\$ref"/u);
    assert.doesNotMatch(JSON.stringify(body), /"\$ref"/u);
    assert.match(JSON.stringify(body), /locationDistrict/u);
  });

  it("keeps root recursive schemas that google sends through parametersJsonSchema", async () => {
    const recursiveSchema = {
      $ref: "#/$defs/node",
      $defs: {
        node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/node" } },
        },
      },
    };
    const normalized = inlineAcyclicLocalJsonSchemaReferences(recursiveSchema);
    assert.deepEqual(normalized.unresolved, [
      { path: "", ref: "#/$defs/node", reason: "recursive" },
    ]);
    assert.equal(providerAcceptsToolSchemaIssues("google", normalized.unresolved), true);

    const body = await captureToolRequest(
      createProviderModel("google", "gemini-3.8-flash", "k"),
      normalized.schema,
    );
    const serialized = JSON.stringify(body);
    assert.match(serialized, /"parametersJsonSchema"/u);
    assert.doesNotMatch(serialized, /"parameters":/u);
  });

  it("openai and anthropic receive the inlined schema verbatim", async () => {
    for (const [provider, modelName] of [
      ["openai", "gpt-5.5"],
      ["anthropic", "claude-sonnet-4-6"],
    ] as const) {
      const body = await captureToolRequest(createProviderModel(provider, modelName, "k"), inlined);
      const text = JSON.stringify(body);
      assert.match(
        text,
        /"locationDistrict":\{"type":"string","minLength":1,"description":"区"\}/u,
        provider,
      );
      assert.doesNotMatch(text, /\$ref/u, provider);
    }
  });

  it("retains Google empty text/reasoning signatures on Google and omits them on all other providers", async () => {
    const promptWithGoogleSignature = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      {
        role: "assistant" as const,
        content: [
          {
            type: "reasoning" as const,
            text: "",
            providerOptions: { google: { thoughtSignature: "sig-reasoning" } },
          },
          { type: "text" as const, text: "Hello" },
          {
            type: "text" as const,
            text: "",
            providerOptions: { google: { thoughtSignature: "sig-text" } },
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: "",
            providerOptions: { google: { thoughtSignature: "sig-only" } },
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [
          {
            type: "reasoning" as const,
            text: "",
            providerOptions: { google: { thoughtSignature: "sig-reasoning-only" } },
          },
        ],
      },
      { role: "user" as const, content: [{ type: "text" as const, text: "next" }] },
    ];

    async function capturePromptRequest(
      model: LanguageModelV4,
      includeStrictTool = false,
    ): Promise<unknown> {
      const originalFetch = globalThis.fetch;
      let body: unknown;
      try {
        globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
          body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          return new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        };
        const result = await model.doStream({
          prompt: promptWithGoogleSignature,
          ...(includeStrictTool
            ? {
                tools: [
                  {
                    type: "function",
                    name: "probe",
                    description: "probe",
                    strict: true,
                    inputSchema: {
                      type: "object",
                      properties: { q: { type: "string" } },
                      required: ["q"],
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : {}),
        });
        await result.stream.cancel();
      } finally {
        globalThis.fetch = originalFetch;
      }
      return body;
    }

    const googleBody = await capturePromptRequest(
      createProviderModel("google", "gemini-3.8-flash", "k"),
    );
    assert.ok(isRecord(googleBody) && Array.isArray(googleBody.contents));
    const firstModelTurn = googleBody.contents[1];
    assert.ok(isRecord(firstModelTurn) && Array.isArray(firstModelTurn.parts));
    assert.deepEqual(firstModelTurn.parts, [
      { text: "", thought: true, thoughtSignature: "sig-reasoning" },
      { text: "Hello" },
      { text: "", thoughtSignature: "sig-text" },
    ]);

    for (const [provider, modelName] of [
      ["openai", "gpt-5.4"],
      ["xai", "grok-4.7"],
    ] as const) {
      const body = await capturePromptRequest(createProviderModel(provider, modelName, "k"));
      assert.ok(isRecord(body) && Array.isArray(body.input), provider);
      const assistantTexts = body.input.flatMap((item: unknown) =>
        isRecord(item) && item.role === "assistant" ? [item.content] : [],
      );
      assert.deepEqual(assistantTexts, ["Hello"], provider);
      assert.doesNotMatch(JSON.stringify(body), /sig-/u, provider);
    }

    for (const [label, baseURL, expectedStrict] of [
      ["deepseek-standard", undefined, false],
      ["deepseek-beta", "https://api.deepseek.com/beta", true],
    ] as const) {
      const body = await capturePromptRequest(
        createProviderModel("deepseek", "deepseek-v4-flash", "k", baseURL),
        true,
      );
      assert.ok(isRecord(body) && Array.isArray(body.messages), label);
      const assistants = body.messages.filter(
        (item: unknown): item is Record<string, unknown> =>
          isRecord(item) && item.role === "assistant",
      );
      assert.deepEqual(
        assistants.map((item) => item.content),
        ["Hello"],
        label,
      );
      assert.doesNotMatch(JSON.stringify(body), /sig-/u, label);
      assert.ok(Array.isArray(body.tools) && isRecord(body.tools[0]), label);
      const fn = body.tools[0].function;
      assert.ok(isRecord(fn), label);
      assert.equal(fn.strict, expectedStrict, label);
    }

    for (const [provider, modelName] of [
      ["anthropic", "claude-sonnet-4-6"],
      ["qwen", "qwen3.6-plus"],
    ] as const) {
      const body = await capturePromptRequest(createProviderModel(provider, modelName, "k"));
      assert.ok(isRecord(body) && Array.isArray(body.messages), provider);
      const assistants = body.messages.filter(
        (item: unknown): item is Record<string, unknown> =>
          isRecord(item) && item.role === "assistant",
      );
      assert.equal(assistants.length, 1, provider);
      assert.doesNotMatch(JSON.stringify(body), /sig-/u, provider);
    }
  });

  it("shouldRetainEmptyReasoningPart only accepts Google namespace thoughtSignature carriers", () => {
    assert.equal(shouldRetainEmptyReasoningPart({ google: { thoughtSignature: "sig-1" } }), true);
    assert.equal(shouldRetainEmptyReasoningPart({ google: { thoughtSignature: "" } }), false);
    assert.equal(
      shouldRetainEmptyReasoningPart({ google: { thoughtSignature: "sig-1", extra: true } }),
      false,
    );
    assert.equal(shouldRetainEmptyReasoningPart({ other: { thoughtSignature: "sig-1" } }), false);
    assert.equal(shouldRetainEmptyReasoningPart({ openai: { thoughtSignature: "sig-1" } }), false);
    assert.equal(
      shouldRetainEmptyReasoningPart({
        google: { thoughtSignature: "sig-1" },
        openai: { itemId: "rs-1" },
      }),
      false,
    );
    assert.equal(
      shouldRetainEmptyReasoningPart({
        openai: { itemId: "rs-private", reasoningEncryptedContent: "enc" },
      }),
      false,
    );
    assert.equal(shouldRetainEmptyReasoningPart({ anthropic: { signature: "sig-ant" } }), false);
  });
});

describe("apiSamplingThinkingLevel xAI boundary", () => {
  it("rejects invalid xAI off source and same-model configs via the 4-arg public API without warnings", () => {
    const invalidCases = ["grok-4.5", "grok-4.6", "grok-4.7"].flatMap((xaiModel) => [
      ...[
        { provider: "google", model: "gemini-4-neon" },
        { provider: "google", model: "gemini-3.8-flash" },
        { provider: "openai", model: "gpt-5.4" },
      ].map((target) => ({
        label: `xai/${xaiModel} off -> ${target.provider}/${target.model}`,
        runtime: { provider: "xai", model: xaiModel, thinkingLevel: "off" as const },
        apiProvider: target.provider,
        apiModel: target.model,
        expectedModel: xaiModel,
      })),
      ...[
        { provider: "xai", model: xaiModel, thinkingLevel: "off" as const },
        { provider: "xai", thinkingLevel: "off" as const },
        { thinkingLevel: "off" as const },
      ].map((runtime, index) => ({
        label: `same-model ${xaiModel} off #${String(index + 1)}`,
        runtime,
        apiProvider: "xai",
        apiModel: xaiModel,
        expectedModel: xaiModel,
      })),
    ]);

    for (const item of invalidCases) {
      assert.throws(
        () =>
          apiSamplingThinkingLevel(
            item.runtime,
            item.apiProvider,
            () => {
              throw new Error(`${item.label} must not warn or fallback`);
            },
            item.apiModel,
          ),
        (error: unknown) =>
          error instanceof UnsupportedThinkingLevelError &&
          error.message.includes(`模型 ${item.expectedModel} 不支持关闭思考`) &&
          error.message.includes("runtime.thinking-level"),
        item.label,
      );
    }

    const sameEffectiveLevel = apiSamplingThinkingLevel(
      { provider: "xai", model: " GROK-4.5 ", thinkingLevel: "off" },
      "xai",
      () => {
        throw new Error("same effective xAI model must not warn");
      },
      "grok-4.5",
    );
    assert.equal(sameEffectiveLevel, "off");
    assert.throws(
      () =>
        resolveLLMCall("xai", "grok-4.5", "test-key", "sampling", undefined, sameEffectiveLevel),
      UnsupportedThinkingLevelError,
    );
  });

  it("downgrades valid cross-model and subscription off configs to medium on Grok 4.5-4.7 while preserving supported/fixed xAI models and structured-output constraints", async () => {
    const downgradeSources = [
      {
        label: "Google 3.8 Flash off",
        runtime: { provider: "google", model: "gemini-3.8-flash", thinkingLevel: "off" as const },
        prefix: "聊天模型 google/gemini-3\\.8-flash 的推理强度 off",
      },
      {
        label: "ChatGPT subscription off",
        runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" as const },
        prefix: "ChatGPT 聊天强度 off",
      },
      {
        label: "xAI grok-4.3 off",
        runtime: { provider: "xai", model: "grok-4.3", thinkingLevel: "off" as const },
        prefix: "聊天模型 xai/grok-4\\.3 的推理强度 off",
      },
    ] as const;

    for (const xaiTarget of ["grok-4.5", "grok-4.6", "grok-4.7"] as const) {
      for (const source of downgradeSources) {
        const warnings: string[] = [];
        const resolved = apiSamplingThinkingLevel(
          source.runtime,
          "xai",
          (message) => warnings.push(message),
          xaiTarget,
        );
        assert.equal(resolved, "medium", `${source.label} -> ${xaiTarget}`);
        assert.equal(warnings.length, 1, `${source.label} -> ${xaiTarget}`);
        assert.match(
          warnings[0] ?? "",
          new RegExp(
            `${source.prefix} 不适用于独立 API Sampling 模型 xai/${xaiTarget}.*默认 medium`,
          ),
        );
      }
    }

    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    try {
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = input instanceof Request ? input.url : String(input);
        capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const fallbackLevel = apiSamplingThinkingLevel(
        { provider: "google", model: "gemini-3.8-flash", thinkingLevel: "off" },
        "xai",
        () => {},
        "grok-4.5",
      );
      const call = resolveLLMCall(
        "xai",
        "grok-4.5",
        "test-key",
        "sampling",
        undefined,
        fallbackLevel,
      );
      const streamResult = await call.model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "probe" }] }],
        ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
      });
      await streamResult.stream.cancel();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(capturedUrl, "https://api.x.ai/v1/responses");
    assert.ok(isRecord(capturedBody));
    assert.equal(capturedBody.model, "grok-4.5");
    assert.deepEqual(capturedBody.reasoning, { effort: "medium" });

    for (const compatibleTarget of [
      { model: "grok-4.3", expectedOptions: { xai: { reasoningEffort: "none" } } },
      { model: "grok-4.20-reasoning", expectedOptions: undefined },
      { model: "grok-4.20-non-reasoning", expectedOptions: undefined },
      { model: "grok-3", expectedOptions: undefined },
    ] as const) {
      for (const runtime of [
        { provider: "google", model: "gemini-3.8-flash", thinkingLevel: "off" as const },
        { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" as const },
      ]) {
        const level = apiSamplingThinkingLevel(
          runtime,
          "xai",
          () => {
            throw new Error(`${compatibleTarget.model} must not warn on off`);
          },
          compatibleTarget.model,
        );
        assert.equal(level, "off");
        const call = resolveLLMCall(
          "xai",
          compatibleTarget.model,
          "test-key",
          "sampling",
          undefined,
          level,
        );
        assert.deepEqual(call.providerOptions, compatibleTarget.expectedOptions);
      }
    }

    for (const model of ["grok-4.5", "grok-4.20-reasoning", "grok-4.20-multi-agent"] as const) {
      assert.throws(
        () => resolveLLMCall("xai", model, "test-key", "structured-output", undefined, "off"),
        (error: unknown) =>
          error instanceof UnsupportedThinkingLevelError &&
          error.message.includes(`模型 ${model} 不支持关闭思考`) &&
          error.message.includes("runtime.compaction.thinking-level"),
      );
    }
  });
});
