import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { compactMessages } from "./compactor.ts";
import { estimatePreparedRequest } from "./request-budget.ts";

function summaryModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Continue with the current request." }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

for (const fragment of ["inspection ", "检查记录", "🧪", '\\"\n']) {
  test(`summary request fits complete UTF-8 source prefixes: ${JSON.stringify(fragment)}`, async () => {
    const messages: ModelMessage[] = Array.from({ length: 12 }, (_, index) => [
      { role: "user" as const, content: `request-${index}` },
      { role: "assistant" as const, content: `${fragment.repeat(1000)}END-${index}` },
    ]).flat();
    const model = summaryModel();
    const result = await compactMessages({
      messages,
      model,
      strategy: "summarize",
      keepRecentTurns: 1,
      keepRecentTokens: 1,
      contextWindow: 8000,
      maxOutputTokens: 500,
    });
    assert.ok(result.removed > 0 && result.removed < messages.length - 2);
    assert.equal(model.doGenerateCalls.length, 1);
    const call = model.doGenerateCalls[0]!;
    const budget = estimatePreparedRequest(
      call,
      { provider: model.provider, model: model.modelId, window: 8000 },
      0,
    );
    assert.ok(budget.rawInputEstimate <= budget.availableInputCeiling!);
    const user = call.prompt.find((message) => message.role === "user");
    assert.ok(user?.role === "user");
    const text = user.content[0];
    assert.ok(text?.type === "text");
    const payload = z.object({ removedHistory: z.array(z.unknown()) }).parse(JSON.parse(text.text));
    const kept = new Set(result.messages);
    assert.deepEqual(
      payload.removedHistory,
      messages.filter((message) => !kept.has(message)),
    );
    assert.ok(
      result.messages.every((message) => messages.includes(message)),
      "kept sources are never replaced by excerpts",
    );
  });
}

const imageData = "QUJD".repeat(250_000);
for (const [name, image] of Object.entries({
  base64: imageData,
  dataUrl: `data:image/png;base64,${imageData}`,
  urlObject: new URL(`data:image/png;base64,${imageData}`),
  bytes: new Uint8Array(750_000).fill(65),
  buffer: Buffer.alloc(750_000, 65),
  arrayBuffer: new Uint8Array(750_000).fill(65).buffer,
})) {
  test(`summary omits inline image bytes without changing history: ${name}`, async () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect screenshot" },
          { type: "image", image, mediaType: "image/png" },
        ],
      },
      { role: "assistant", content: "Observed a red button. " + "detail ".repeat(1000) },
      { role: "user", content: "Continue" },
    ];
    const before = JSON.stringify(messages);
    const model = summaryModel();
    const result = await compactMessages({
      messages,
      model,
      strategy: "summarize",
      keepRecentTurns: 1,
      keepRecentTokens: 1,
      contextWindow: 128_000,
      maxOutputTokens: 1000,
    });
    assert.equal(result.removed, 2);
    assert.equal(model.doGenerateCalls.length, 1);
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    assert.ok(prompt.length < 20_000);
    assert.match(prompt, /Observed a red button/);
    assert.match(prompt, /sha256/);
    assert.match(prompt, /omitted/);
    assert.ok(!prompt.includes(imageData));
    assert.equal(JSON.stringify(messages), before);
    assert.equal(result.messages[0], messages[2]);
  });
}

test("summary projects SDK file and tool media only, preserving business JSON and text", async () => {
  const business = { type: "image", image: "business-value", data: "must remain" };
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "image/png",
          filename: "screen.png",
          data: { type: "data", data: imageData },
        },
        {
          type: "file",
          mediaType: "text/plain",
          data: { type: "text", text: "verbatim file text" },
        },
        { type: "image", image: new URL("https://example.test/image.png") },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "reference", reference: { test: "file-123" } },
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "read", toolName: "read", input: business }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "read",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "observed tool text" },
              { type: "file", mediaType: "image/png", data: { type: "data", data: imageData } },
              { type: "image-data", mediaType: "image/png", data: imageData },
              { type: "file-data", mediaType: "image/png", data: imageData },
              { type: "image-url", url: `data:image/png;base64,${imageData}` },
            ],
          },
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "json", toolName: "read", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "json",
          toolName: "read",
          output: { type: "json", value: business },
        },
      ],
    },
    { role: "user", content: "Continue" },
  ];
  const before = JSON.stringify(messages);
  const model = summaryModel();
  const result = await compactMessages({
    messages,
    model,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    contextWindow: 128_000,
    maxOutputTokens: 1000,
  });
  assert.equal(result.removed, 5);
  const call = model.doGenerateCalls[0]!;
  const user = call.prompt.find((message) => message.role === "user");
  assert.ok(user?.role === "user" && user.content[0]?.type === "text");
  const text = user.content[0].text;
  assert.ok(text.length < 10_000);
  for (const expected of [
    "screen.png",
    "verbatim file text",
    "https://example.test/image.png",
    "file-123",
    "observed tool text",
    JSON.stringify(business),
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.ok(!text.includes(imageData));
  assert.equal(JSON.stringify(messages), before);
  const budget = estimatePreparedRequest(
    call,
    { provider: model.provider, model: model.modelId, window: 128_000 },
    0,
  );
  assert.ok(budget.rawInputEstimate <= budget.availableInputCeiling!);
});

test("an oversized first source stays intact and cannot be bypassed by deleting later history", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "important".repeat(20_000) },
    { role: "assistant", content: "old response" },
    { role: "user", content: "current" },
  ];
  const model = summaryModel();
  const result = await compactMessages({
    messages,
    model,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    contextWindow: 4000,
  });
  assert.equal(result.removed, 0);
  assert.deepEqual(result.messages, messages);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("packing counts provider options, previous summary and output reservation", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Earlier request." },
    { role: "assistant", content: "Earlier inspection." },
    { role: "user", content: "Continue." },
  ];
  for (const extra of [
    { structuredOutputProviderOptions: { test: { metadata: "重要".repeat(5000) } } },
    { previousSummary: "Earlier fact".repeat(5000) },
    { contextWindow: 10 },
  ]) {
    const model = summaryModel();
    const result = await compactMessages({
      messages,
      model,
      strategy: "summarize",
      keepRecentTurns: 1,
      keepRecentTokens: 1,
      contextWindow: 8000,
      maxOutputTokens: 2000,
      ...extra,
    });
    assert.equal(result.removed, 0);
    assert.deepEqual(result.messages, messages);
    assert.equal(model.doGenerateCalls.length, 0);
  }
});

test("source packing backs off at settled steps in a long old turn while keeping its user", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "old-anchor" }];
  for (let index = 0; index < 8; index += 1) {
    messages.push({ role: "assistant", content: `STEP-${index}:` + "x".repeat(3000) });
  }
  messages.push({ role: "user", content: "current" });
  const model = summaryModel();
  const result = await compactMessages({
    messages,
    model,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    contextWindow: 4000,
    maxOutputTokens: 500,
  });
  assert.ok(result.removed > 0 && result.removed < 9);
  assert.equal(result.messages[0], messages[0]);
  assert.equal(result.messages.at(-1), messages.at(-1));
  const call = model.doGenerateCalls[0]!;
  const user = call.prompt.find((message) => message.role === "user");
  assert.ok(user?.role === "user" && user.content[0]?.type === "text");
  const payload = z
    .object({ retainedUserMessages: z.array(z.unknown()) })
    .parse(JSON.parse(user.content[0].text));
  assert.deepEqual(payload.retainedUserMessages, [messages[0], messages.at(-1)]);
});

test("retained user context participates in summary packing instead of bypassing the budget", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Review only" },
    { role: "assistant", content: "Found a P2 issue" },
    { role: "user", content: "Fix it under these constraints: " + "重要约束".repeat(10_000) },
  ];
  const model = summaryModel();
  const result = await compactMessages({
    messages,
    model,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    contextWindow: 4000,
    maxOutputTokens: 500,
  });
  assert.equal(result.removed, 0);
  assert.deepEqual(result.messages, messages);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("retained user media is projected while preserving its instruction and original payload", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Review only" },
    { role: "assistant", content: "Found a P2 issue" },
    {
      role: "user",
      content: [
        { type: "text", text: "按这张截图修复，不要发布。" },
        { type: "image", image: imageData, mediaType: "image/png" },
      ],
    },
  ];
  const before = structuredClone(messages);
  const model = summaryModel();
  const result = await compactMessages({
    messages,
    model,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    contextWindow: 8000,
    maxOutputTokens: 500,
  });
  assert.equal(result.removed, 2);
  assert.equal(model.doGenerateCalls.length, 1);
  const call = model.doGenerateCalls[0]!;
  const user = call.prompt.find((message) => message.role === "user");
  assert.ok(user?.role === "user" && user.content[0]?.type === "text");
  const payload = z
    .object({ retainedUserMessages: z.array(z.unknown()) })
    .parse(JSON.parse(user.content[0].text));
  const context = JSON.stringify(payload.retainedUserMessages);
  assert.match(context, /按这张截图修复，不要发布/);
  assert.match(context, /omitted/);
  assert.ok(!context.includes(imageData));
  assert.deepEqual(result.messages, [messages[2]]);
  assert.deepEqual(messages, before);
});
