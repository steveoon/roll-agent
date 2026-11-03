import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RollNodeClient } from "@roll-agent/client-node";
import type { RuntimeEventEnvelope } from "@roll-agent/protocol";
import { runRoll } from "./smoke.e2e-harness.ts";

function openAiEvents() {
  const reasoning = { type: "reasoning", id: "rs-test" };
  const message = { type: "message", id: "msg-test" };
  return [
    {
      type: "response.created",
      response: { id: "resp-test", model: "gpt-5", created_at: 1700000000 },
    },
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: reasoning.id,
      summary_index: 0,
      delta: "Display fixture.",
    },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: message },
    { type: "response.output_text.delta", output_index: 1, item_id: message.id, delta: "Answer." },
    { type: "response.output_item.done", output_index: 1, item: message },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 5, output_tokens: 5 } },
    },
  ];
}

function chatCompletionEvents(model: string, withReasoning = true) {
  const deltas = [
    ...(withReasoning ? [{ reasoning_content: "Display fixture." }] : []),
    { content: "Answer." },
    {},
  ];
  return deltas.map((delta, index) => ({
    id: "chat-test",
    model,
    created: 1700000000,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: index === deltas.length - 1 ? "stop" : null }],
  }));
}

function claudeEvents(withSummary: boolean) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg-test",
        model: "claude-sonnet-4-6",
        role: "assistant",
        type: "message",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "opaque-redacted-fixture" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    ...(withSummary
      ? [
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "thinking_delta", thinking: "Display fixture." },
          },
        ]
      : []),
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "opaque-signature-fixture" },
    },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Answer." } },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
}

function geminiEvents(withSummary: boolean) {
  const signature = { thoughtSignature: "opaque-signature-fixture" };
  return [
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              ...(withSummary
                ? [
                    { thought: true, text: "Dis" },
                    { thought: true, text: "play ", ...signature },
                  ]
                : []),
              { thought: true, text: "", ...signature },
              { text: "An" },
              ...(withSummary ? [{ thought: true, text: "fixture." }] : []),
              { text: "swer.", ...signature },
            ],
          },
          finishReason: "STOP",
        },
        {
          content: { role: "model", parts: [{ thought: true, text: "opaque-alternate-fixture" }] },
        },
      ],
    },
  ];
}

function grokEvents(withSummary: boolean) {
  const ids = { output_index: 0, item_id: "rs-grok" };
  const reasoning = {
    type: "reasoning",
    id: ids.item_id,
    status: "completed",
    summary: [],
    encrypted_content: "opaque-encrypted-fixture",
  };
  const message = {
    type: "message",
    role: "assistant",
    id: "msg-grok",
    status: "completed",
    content: [{ type: "output_text", text: "Answer." }],
  };
  return [
    ...(withSummary
      ? [
          {
            type: "response.reasoning_summary_part.added",
            ...ids,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            ...ids,
            summary_index: 0,
            delta: "Display ",
          },
          { type: "response.reasoning_text.delta", ...ids, content_index: 0, delta: "fixture." },
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      delta: "Answer.",
    },
    { type: "response.output_item.done", output_index: 1, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp-grok",
        object: "response",
        status: "completed",
        output: [reasoning, message],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    },
  ];
}

interface DisplayCase {
  name: string;
  provider: string;
  model: string;
  chunks: readonly Record<string, unknown>[];
  summary?: boolean;
  expectedSubscription?: boolean;
  thinkingOff?: boolean;
  invalidResponse?: boolean;
  expected?: "reasoning.summary.delta" | "reasoning.text.delta";
}

const claude = { provider: "anthropic", model: "claude-sonnet-4-6" };
const gemini = { provider: "google", model: "gemini-3.8-flash" };
const grok = { provider: "xai", model: "grok-4.7" };
test("both stdio entry points report an unsupported Grok setting on stderr", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "roll-grok-config-"));
  try {
    await writeFile(
      join(workspace, "roll.config.yaml"),
      `llm:
  default-provider: xai
  default-model: grok-4.7
  providers:
    xai:
      api-key: fixture-only
      base-url: http://127.0.0.1:1/v1
runtime:
  thinking-level: "off"
`,
    );
    for (const args of [
      ["runtime", "serve", "--stdio"],
      ["chat", "--server"],
    ]) {
      const { status, stdout, stderr } = runRoll(args, workspace);
      assert.equal(status, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /grok-4\.7 不支持关闭思考。请将 runtime\.thinking-level 设为 low/u);
      assert.doesNotMatch(stderr, /^\s*at /mu);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
const deepseek = {
  provider: "deepseek",
  model: "deepseek-flash",
  chunks: chatCompletionEvents("deepseek-flash"),
};
const qwen = {
  provider: "qwen",
  model: "qwen3.6-plus",
  chunks: chatCompletionEvents("qwen3.6-plus"),
};
const cases: DisplayCase[] = [
  {
    name: "OpenAI summary",
    provider: "openai",
    model: "gpt-5",
    chunks: openAiEvents(),
    summary: true,
    expected: "reasoning.summary.delta",
  },
  {
    name: "DeepSeek subscribed",
    ...deepseek,
    expectedSubscription: true,
    expected: "reasoning.text.delta",
  },
  { name: "DeepSeek unsubscribed", ...deepseek },
  {
    name: "DeepSeek off refuses subscription and ignores unexpected thinking",
    ...deepseek,
    thinkingOff: true,
    expectedSubscription: false,
  },
  {
    name: "OpenAI off ignores unexpected summary",
    provider: "openai",
    model: "gpt-5.5",
    chunks: openAiEvents(),
    thinkingOff: true,
  },
  {
    name: "OpenAI non-reasoning model ignores unexpected summary",
    provider: "openai",
    model: "gpt-4o",
    chunks: openAiEvents(),
  },
  {
    name: "Claude summary",
    ...claude,
    chunks: claudeEvents(true),
    summary: true,
    expected: "reasoning.summary.delta",
  },
  { name: "Claude signatures only", ...claude, chunks: claudeEvents(false), summary: true },
  {
    name: "Claude thinking off ignores unexpected thinking text",
    ...claude,
    chunks: claudeEvents(true),
    thinkingOff: true,
  },
  {
    name: "Qwen subscribed",
    ...qwen,
    expectedSubscription: true,
    expected: "reasoning.text.delta",
  },
  { name: "Qwen unsubscribed", ...qwen },
  {
    name: "Qwen answer only",
    ...qwen,
    expectedSubscription: true,
    chunks: chatCompletionEvents(qwen.model, false),
  },
  {
    name: "Qwen thinking off ignores unexpected thinking text",
    ...qwen,
    expectedSubscription: false,
    thinkingOff: true,
  },
  {
    name: "Gemini multiple summary deltas and reasoning blocks in one native chunk",
    ...gemini,
    chunks: geminiEvents(true),
    summary: true,
    expected: "reasoning.summary.delta",
  },
  {
    name: "Gemini signatures without summary",
    ...gemini,
    chunks: geminiEvents(false),
    summary: true,
  },
  {
    name: "Gemini thinking off ignores unexpected thought parts",
    ...gemini,
    chunks: geminiEvents(true),
    thinkingOff: true,
  },
  {
    name: "Grok 4.7 both documented summary delta types",
    ...grok,
    chunks: grokEvents(true),
    summary: true,
    expected: "reasoning.summary.delta",
  },
  {
    name: "Grok 4.7 encrypted item only",
    ...grok,
    chunks: grokEvents(false),
    summary: true,
  },
  {
    name: "Grok malformed private item is absent from the durable failure and replay",
    ...grok,
    summary: true,
    invalidResponse: true,
    chunks: [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs-invalid",
          summary: [],
          encrypted_content: "opaque-encrypted-fixture",
        },
      },
    ],
  },
  {
    name: "Grok 4.5 does not inherit 4.7 summary semantics",
    ...grok,
    model: "grok-4.5",
    chunks: grokEvents(true),
    expectedSubscription: false,
  },
];
for (const scenario of cases) {
  const { provider, model, chunks, expectedSubscription, expected } = scenario;
  test(`stdio reasoning display: ${scenario.name}`, { timeout: 30_000 }, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "roll-display-"));
    let requestBody = "";
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (part: string) => {
        requestBody += part;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""));
      });
    });
    let client: RollNodeClient | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      await writeFile(
        join(workspace, "roll.config.yaml"),
        `llm:
  default-provider: ${provider}
  default-model: ${model}
  providers:
    ${provider}:
      api-key: fixture-only
      base-url: http://127.0.0.1:${address.port}/v1
runtime:
  provider: ${provider}
  model: ${model}
  thinking-level: ${scenario.thinkingOff ? '"off"' : '"medium"'}
  threads-dir: ${workspace}/threads
agents:
  data-dir: ${workspace}/agents
`,
      );
      client = await RollNodeClient.start({
        command: process.execPath,
        cwd: workspace,
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
        args: [
          "--experimental-strip-types",
          "--experimental-sqlite",
          join(import.meta.dirname, "index.ts"),
          "runtime",
          "serve",
          "--stdio",
        ],
      });
      assert.equal(
        client.getInitializationResult().features.includes("reasoning-summary"),
        scenario.summary === true,
      );
      if (expectedSubscription !== undefined) {
        assert.deepEqual(await client.request("reasoning.text.subscribe", {}), {
          subscribed: expectedSubscription,
        });
      }
      const { thread } = await client.request("thread.create", { requestId: randomUUID() });
      const events: RuntimeEventEnvelope[] = [];
      const ended = Promise.withResolvers<void>();
      client.onEvent((event) => {
        events.push(event);
        if (event.event.type === "turn.completed") ended.resolve();
        if (event.event.type === "turn.failed" || event.event.type === "turn.cancelled") {
          if (scenario.invalidResponse && event.event.type === "turn.failed") ended.resolve();
          else ended.reject(new Error(JSON.stringify(event.event)));
        }
      });
      t.signal.addEventListener("abort", () => ended.reject(t.signal.reason), { once: true });
      await client.request("turn.start", {
        requestId: randomUUID(),
        threadId: thread.id,
        turnId: randomUUID(),
        input: { text: "fixture" },
      });
      await ended.promise;
      const body: unknown = JSON.parse(requestBody);
      if (provider === "openai") {
        assert.ok(typeof body === "object" && body !== null);
        const reasoning = "reasoning" in body ? body.reasoning : undefined;
        assert.deepEqual(
          reasoning,
          model === "gpt-4o"
            ? undefined
            : scenario.thinkingOff
              ? { effort: "none" }
              : { effort: "medium", summary: "detailed" },
        );
      }
      if (provider === "deepseek") {
        assert.ok(typeof body === "object" && body !== null && "thinking" in body);
        assert.deepEqual(body.thinking, { type: scenario.thinkingOff ? "disabled" : "enabled" });
      }
      if (provider === "google") {
        assert.ok(typeof body === "object" && body !== null && "generationConfig" in body);
        const config = body.generationConfig;
        assert.ok(typeof config === "object" && config !== null && "thinkingConfig" in config);
        assert.deepEqual(
          config.thinkingConfig,
          scenario.thinkingOff
            ? { thinkingLevel: "low" }
            : { thinkingLevel: "medium", includeThoughts: true },
        );
      }
      if (provider === "xai") {
        assert.ok(
          typeof body === "object" && body !== null && "reasoning" in body && "model" in body,
        );
        assert.equal(body.model, model);
        assert.deepEqual(body.reasoning, { effort: "medium" });
      }
      if (provider === "qwen") {
        assert.ok(typeof body === "object" && body !== null && "enable_thinking" in body);
        assert.equal(body.enable_thinking, scenario.thinkingOff !== true);
      }
      if (provider === "anthropic") {
        assert.ok(typeof body === "object" && body !== null && "thinking" in body);
        assert.deepEqual(
          body.thinking,
          scenario.thinkingOff ? { type: "disabled" } : { type: "adaptive", display: "summarized" },
        );
      }
      if (scenario.invalidResponse) {
        const liveFailure = events.find(({ event }) => event.type === "turn.failed");
        assert.ok(liveFailure?.event.type === "turn.failed");
        assert.equal(liveFailure.event.message, "模型调用的数据未通过格式校验。");
        await client.request("runtime.events.resume", { threadId: thread.id, afterCursor: null });
        const failures = events.filter(({ event }) => event.type === "turn.failed");
        assert.equal(failures.length, 2);
        assert.doesNotMatch(JSON.stringify(failures), /opaque-[\w-]*fixture/u);
        return;
      }
      assert.doesNotMatch(JSON.stringify(events), /opaque-[\w-]*fixture/u);
      const snapshot = await client.request("thread.snapshot", { threadId: thread.id });
      assert.doesNotMatch(JSON.stringify(snapshot), /Display fixture|opaque-[\w-]*fixture/u);
      const display = events.flatMap(({ event }) =>
        event.type === "reasoning.text.delta" || event.type === "reasoning.summary.delta"
          ? [event]
          : [],
      );
      assert.deepEqual(
        [...new Set(display.map((event) => event.type))],
        expected ? [expected] : [],
      );
      if (expected) {
        assert.equal(display.map((event) => event.delta).join(""), "Display fixture.");
      } else assert.doesNotMatch(JSON.stringify(events), /Display fixture/u);
      assert.ok(
        events.some(({ event }) => event.type === "message.completed" && event.text === "Answer."),
      );
    } finally {
      await client?.shutdown();
      server.closeAllConnections();
      server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
