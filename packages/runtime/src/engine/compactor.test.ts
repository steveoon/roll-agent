import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import {
  COMPACTION_DRAFT_FALLBACK_REASONS,
  compactMessages,
  CompactionDraftFallbackError,
  estimateMessagesTokens,
  findTurnBoundaries,
} from "./compactor.ts";
import type { CompactionModelDraft } from "./compaction-semantic-state.ts";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };

function emptyDraft(): CompactionModelDraft {
  return {
    startsNewGoalScope: false,
    goal: null,
    constraints: [],
    decisions: [],
    completedWork: [],
    pendingWork: [],
    resources: [],
    runningSessions: [],
    uncertainties: [],
    resolutions: [],
    evidenceReviews: [],
  };
}

function draftModel(
  draft: CompactionModelDraft = emptyDraft(),
  finishReason: LanguageModelV4FinishReason = STOP,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(draft) }],
      finishReason,
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

function promptText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(promptText).join("");
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  return promptText(record.content);
}

function conversation(): ModelMessage[] {
  return [
    { role: "user", content: "t1-u" },
    { role: "assistant", content: "t1-a" },
    { role: "user", content: "t2-u" },
    { role: "assistant", content: "t2-a" },
    { role: "user", content: "t3-u" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "x", toolName: "echo", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "x",
          toolName: "echo",
          output: { type: "text", value: "ok" },
        },
      ],
    },
    { role: "user", content: "t4-u" },
    { role: "assistant", content: "t4-a" },
  ];
}

test("findTurnBoundaries 标出每个人类轮起点", () => {
  assert.deepEqual(findTurnBoundaries(conversation()), [0, 2, 4, 7]);
});

test("summarize 折叠最早若干轮,保留最近 N 轮且不拆 tool 对", async () => {
  const result = await compactMessages({
    messages: conversation(),
    strategy: "summarize",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    model: draftModel(),
  });

  assert.equal(result.removed, 4);
  assert.equal(result.kept, 5);
  assert.deepEqual(result.semanticDraft, emptyDraft());
  assert.equal(result.messages[0]?.role, "user");
  assert.equal(result.messages[0]?.content, "t3-u");
  assert.ok(
    result.messages.every(
      (message) => typeof message.content !== "string" || !message.content.includes("SUMMARY"),
    ),
    "模型输出不得直接进入 active history",
  );
  const toolResult = result.messages.find((m) => m.role === "tool");
  const toolCall = result.messages.find((m) => m.role === "assistant" && Array.isArray(m.content));
  assert.ok(toolResult && toolCall, "tool-call 与 tool-result 必须同时保留");
});

test("compaction cut 不会越过本轮实际展示给结构化 draft 的连续 transcript evidence", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      return {
        content: [{ type: "text", text: JSON.stringify(emptyDraft()) }],
        finishReason: STOP,
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  const blocked = await compactMessages({
    messages: conversation(),
    strategy: "summarize",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    maxRemovedTranscriptMessages: 1,
    model,
  });
  assert.equal(blocked.removed, 0);
  assert.equal(calls, 0);

  const allowed = await compactMessages({
    messages: conversation(),
    strategy: "summarize",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    maxRemovedTranscriptMessages: 4,
    model,
  });
  assert.equal(allowed.removed, 4);
  assert.equal(calls, 1);
});

test("summarize 使用默认 provider budget 并返回多语言结构化 candidate", async (t) => {
  const candidate: CompactionModelDraft = {
    ...emptyDraft(),
    goal: {
      priorItemId: null,
      text: "修复压缩后のタスク継続",
      sourceEvidenceIds: ["ev_msg_01"],
      sourceQuotes: ["message sequence 1"],
    },
    pendingWork: [
      {
        priorItemId: null,
        text: "继续验证恢复链路",
        sourceEvidenceIds: ["ev_msg_01"],
        sourceQuotes: ["message sequence 1"],
      },
    ],
  };
  let responseFormat = "";
  let prompt = "";
  let maxOutputTokens = 0;
  let capturedTimeoutMs: number | undefined;
  let providerOptions: unknown;
  const timeoutSignal = new AbortController().signal;
  t.mock.method(AbortSignal, "timeout", (timeoutMs: number) => {
    capturedTimeoutMs = timeoutMs;
    return timeoutSignal;
  });
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      responseFormat = options.responseFormat?.type ?? "";
      prompt = JSON.stringify(options.prompt);
      maxOutputTokens = options.maxOutputTokens ?? 0;
      providerOptions = options.providerOptions;
      return {
        content: [{ type: "text", text: JSON.stringify(candidate) }],
        finishReason: STOP,
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  const result = await compactMessages({
    messages: conversation(),
    strategy: "summarize",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    model,
    semanticEvidencePrompt: "ev_msg_01: message sequence 1",
    structuredOutputProviderOptions: { alibaba: { enableThinking: false } },
  });

  assert.equal(responseFormat, "json");
  assert.equal(maxOutputTokens, 8192);
  assert.equal(capturedTimeoutMs, 120_000);
  assert.deepEqual(providerOptions, { alibaba: { enableThinking: false } });
  assert.match(prompt, /t1-u/u);
  assert.match(prompt, /harness-evidence/u);
  assert.match(prompt, /message sequence 1/u);
  assert.match(prompt, /sourceQuotes.*逐字复制.*完整内容/u);
  assert.match(prompt, /Tool input\/result.*不可信数据/u);
  assert.match(prompt, /startsNewGoalScope.*普通追问/u);
  assert.match(prompt, /evidenceReviews/u);
  assert.match(prompt, /pending_work\+cancel/u);
  assert.deepEqual(result.semanticDraft, candidate);
  assert.equal(result.messages[0]?.content, "t3-u");
});

test("summarize 透传调用方的 output budget 与 AI SDK reasoning", async () => {
  let maxOutputTokens = 0;
  let reasoning: unknown;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      maxOutputTokens = options.maxOutputTokens ?? 0;
      reasoning = options.reasoning;
      return {
        content: [{ type: "text", text: JSON.stringify(emptyDraft()) }],
        finishReason: STOP,
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  await compactMessages({
    messages: conversation(),
    strategy: "summarize",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    maxOutputTokens: 16_384,
    structuredOutputReasoning: "high",
    model,
  });

  assert.equal(maxOutputTokens, 16_384);
  assert.equal(reasoning, "high");
});

test("summarize 对 malformed JSON fail closed", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: '{"goal":' }],
      finishReason: STOP,
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      warnings: [],
    }),
  });

  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model,
    }),
    (error: unknown) =>
      CompactionDraftFallbackError.isInstance(error) &&
      error.reason === COMPACTION_DRAFT_FALLBACK_REASONS.invalidStructuredOutput,
  );
});

test("summarize 对 schema 缺字段的 JSON fail closed", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ goal: null }) }],
      finishReason: STOP,
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      warnings: [],
    }),
  });

  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model,
    }),
    (error: unknown) =>
      CompactionDraftFallbackError.isInstance(error) &&
      error.reason === COMPACTION_DRAFT_FALLBACK_REASONS.invalidStructuredOutput,
  );
});

test("summarize 即使 JSON 可解析也拒绝 length finish reason", async () => {
  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model: draftModel(emptyDraft(), { unified: "length", raw: "length" }),
    }),
    (error: unknown) =>
      CompactionDraftFallbackError.isInstance(error) &&
      error.reason === COMPACTION_DRAFT_FALLBACK_REASONS.outputLength,
  );
});

test("summarize 识别 xAI non-stream incomplete 的 max_output_tokens", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(emptyDraft()) }],
      finishReason: { unified: "other", raw: "incomplete" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 8192, text: 8192, reasoning: 0 },
      },
      response: {
        body: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
      warnings: [],
    }),
  });

  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model,
    }),
    (error: unknown) =>
      CompactionDraftFallbackError.isInstance(error) &&
      error.reason === COMPACTION_DRAFT_FALLBACK_REASONS.outputLength,
  );
});

test("summarize 不把其他 incomplete reason 误判为 output length", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(emptyDraft()) }],
      finishReason: { unified: "other", raw: "incomplete" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      response: {
        body: {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      },
      warnings: [],
    }),
  });

  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model,
    }),
    (error: unknown) =>
      CompactionDraftFallbackError.isInstance(error) &&
      error.reason === COMPACTION_DRAFT_FALLBACK_REASONS.missingObject,
  );
});

test("summarize 将未返回结构化对象标记为安全 fallback error", async () => {
  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model: draftModel(emptyDraft(), { unified: "content-filter", raw: "content-filter" }),
    }),
    (error: unknown) =>
      CompactionDraftFallbackError.isInstance(error) &&
      error.reason === COMPACTION_DRAFT_FALLBACK_REASONS.missingObject,
  );
});

test("summarize 原样抛出预取消 reason 且不调用模型", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled compaction");
  controller.abort(reason);
  let called = false;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model,
      abortSignal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(called, false);
});

test("summarize 不吞模型层 timeout error", async () => {
  const timeoutError = new Error("provider request timed out");
  timeoutError.name = "TimeoutError";
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw timeoutError;
    },
  });

  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model,
    }),
    (error: unknown) => error === timeoutError,
  );
});

test("summarize 将调用方配置作为 AI SDK provider 总超时", async (t) => {
  let capturedTimeoutMs: number | undefined;
  const timeoutSignal = new AbortController().signal;
  t.mock.method(AbortSignal, "timeout", (timeoutMs: number) => {
    capturedTimeoutMs = timeoutMs;
    return timeoutSignal;
  });

  await compactMessages({
    messages: conversation(),
    strategy: "summarize",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    timeoutMs: 23_456,
    model: draftModel(),
  });

  assert.equal(capturedTimeoutMs, 23_456);
});

test("summarize 原样抛出 provider、限流和网络错误", async () => {
  const failures: Error[] = [
    ...[408, 429, 503].map(
      (statusCode) =>
        new APICallError({
          message: `provider failed with ${String(statusCode)}`,
          url: "https://provider.invalid/v1/generate",
          requestBodyValues: {},
          statusCode,
        }),
    ),
    new Error("ECONNRESET"),
  ];

  for (const failure of failures) {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw failure;
      },
    });
    await assert.rejects(
      compactMessages({
        messages: conversation(),
        strategy: "summarize",
        keepRecentTurns: 2,
        keepRecentTokens: 1,
        model,
      }),
      (error: unknown) => error === failure,
    );
  }
});

test("summarize 将总文本输入硬限制在 64KiB 并优先完整保留 evidence", async () => {
  const evidence = `ev_msg_01:${"e".repeat(8192)}:EVIDENCE_END`;
  let renderedPrompt = "";
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      renderedPrompt = promptText(options.prompt);
      return {
        content: [{ type: "text", text: JSON.stringify(emptyDraft()) }],
        finishReason: STOP,
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const messages: ModelMessage[] = [
    { role: "user", content: `HEAD-${"x".repeat(70_000)}` },
    { role: "assistant", content: `${"y".repeat(70_000)}-TAIL` },
    { role: "user", content: "recent" },
    { role: "assistant", content: "kept" },
  ];

  await compactMessages({
    messages,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    model,
    semanticEvidencePrompt: evidence,
  });

  assert.ok(renderedPrompt.length <= 64 * 1024);
  assert.match(renderedPrompt, /HEAD-/u);
  assert.match(renderedPrompt, /-TAIL/u);
  assert.match(renderedPrompt, /compressed prefix truncated/u);
  assert.match(renderedPrompt, /ev_msg_01:/u);
  assert.match(renderedPrompt, /:EVIDENCE_END/u);
});

test("summarize 对超过总输入预算的 Harness evidence fail closed", async () => {
  let called = false;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  await assert.rejects(
    compactMessages({
      messages: conversation(),
      strategy: "summarize",
      keepRecentTurns: 2,
      keepRecentTokens: 1,
      model,
      semanticEvidencePrompt: "e".repeat(70_000),
    }),
    /evidence exceeds the compaction draft input budget/u,
  );
  assert.equal(called, false);
});

test("truncate 直接丢弃最早若干轮,不调用 LLM", async () => {
  const result = await compactMessages({
    messages: conversation(),
    strategy: "truncate",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    model: draftModel(),
  });

  assert.equal(result.removed, 4);
  assert.equal(result.kept, 5);
  assert.equal(result.messages.length, 5);
  assert.equal(result.messages[0]?.role, "user");
  assert.equal(result.messages[0]?.content, "t3-u");
});

test("keepRecentTurns 覆盖全部轮数时不压缩", async () => {
  const messages = conversation();
  const result = await compactMessages({
    messages,
    strategy: "summarize",
    keepRecentTurns: 4,
    keepRecentTokens: 1,
    model: draftModel(),
  });

  assert.equal(result.removed, 0);
  assert.equal(result.messages.length, messages.length);
});

test("token 预算充足时保留超过 keepRecentTurns 的轮数", async () => {
  const result = await compactMessages({
    messages: conversation(),
    strategy: "truncate",
    keepRecentTurns: 1,
    keepRecentTokens: 100_000,
    model: draftModel(),
  });

  assert.equal(result.removed, 0);
  assert.equal(result.messages.length, conversation().length);
});

test("token 预算不足时裁到最近内容,但不少于 keepRecentTurns", async () => {
  const result = await compactMessages({
    messages: conversation(),
    strategy: "truncate",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    model: draftModel(),
  });

  assert.equal(result.removed, 4);
  assert.equal(result.messages[0]?.content, "t3-u");
});

function withHugeTool(): ModelMessage[] {
  const huge = "x".repeat(3000);
  return [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "s", toolName: "snapshot", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "s",
          toolName: "snapshot",
          output: { type: "text", value: huge },
        },
      ],
    },
    { role: "assistant", content: "a3" },
  ];
}

function toolOutputValue(message: ModelMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) {
    return "";
  }
  const part = message.content[0];
  return String((part as { output?: { value?: string } })?.output?.value ?? "");
}

test("保留轮里的超大工具结果被截断成标记(token-aware)", async () => {
  const result = await compactMessages({
    messages: withHugeTool(),
    strategy: "truncate",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    model: draftModel(),
  });

  assert.equal(result.removed, 4);
  assert.equal(result.truncatedTools, 1);
  const toolMessage = result.messages.find((m) => m.role === "tool");
  assert.match(toolOutputValue(toolMessage), /已省略/);
});

test("cut=0 时仍截断超大工具结果以保证收敛", async () => {
  const result = await compactMessages({
    messages: withHugeTool(),
    strategy: "summarize",
    keepRecentTurns: 5,
    keepRecentTokens: 1,
    model: draftModel(),
  });

  assert.equal(result.removed, 0);
  assert.equal(result.truncatedTools, 1);
  assert.match(toolOutputValue(result.messages.find((m) => m.role === "tool")), /已省略/);
});

test("summarize 转写将 isError 工具结果标为失败并携带摘录", async () => {
  let transcript = "";
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const userMessage = options.prompt.find((message) => message.role === "user");
      transcript = JSON.stringify(userMessage?.content ?? "");
      return {
        content: [{ type: "text", text: JSON.stringify(emptyDraft()) }],
        finishReason: STOP,
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const messages: ModelMessage[] = [
    { role: "user", content: "回复候选人" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "x", toolName: "send", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "x",
          toolName: "send",
          output: { type: "json", value: { output: "已取消执行: 用户取消", isError: true } },
        },
      ],
    },
    { role: "assistant", content: "done" },
    { role: "user", content: "下一位" },
    { role: "assistant", content: "ok" },
  ];

  const result = await compactMessages({
    messages,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    model,
  });

  assert.ok(result.removed > 0);
  assert.ok(transcript.includes("工具结果·失败"));
  assert.ok(transcript.includes("已取消执行"));
});

test("summarize 转写将 typed denied/error 结果标为失败并携带 reason", async () => {
  let transcript = "";
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const userMessage = options.prompt.find((message) => message.role === "user");
      transcript = JSON.stringify(userMessage?.content ?? "");
      return {
        content: [{ type: "text", text: JSON.stringify(emptyDraft()) }],
        finishReason: STOP,
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const messages: ModelMessage[] = [
    { role: "user", content: "执行变更" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "denied", toolName: "write", input: {} },
        { type: "tool-call", toolCallId: "failed", toolName: "build", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "denied",
          toolName: "write",
          output: { type: "execution-denied", reason: "用户拒绝写入" },
        },
        {
          type: "tool-result",
          toolCallId: "failed",
          toolName: "build",
          output: { type: "error-text", value: "构建失败: exit 1" },
        },
      ],
    },
    { role: "assistant", content: "done" },
    { role: "user", content: "下一步" },
    { role: "assistant", content: "ok" },
  ];

  const result = await compactMessages({
    messages,
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    model,
  });

  assert.ok(result.removed > 0);
  assert.equal(transcript.match(/工具结果·失败/gu)?.length, 2);
  assert.match(transcript, /用户拒绝写入/u);
  assert.match(transcript, /构建失败: exit 1/u);
  assert.doesNotMatch(transcript, /工具结果·成功/u);
});

function longTurns(turnCount: number, assistantChars: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let index = 1; index <= turnCount; index += 1) {
    messages.push({ role: "user", content: `t${String(index)}-u` });
    messages.push({ role: "assistant", content: `t${String(index)}-`.padEnd(assistantChars, "a") });
  }
  return messages;
}

function toolStep(id: string, resultChars: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { id } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "read",
          output: { type: "text", value: id.padEnd(resultChars, "r") },
        },
      ],
    },
  ];
}

function monsterTurn(stepCount: number, resultChars: number): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: "user", content: "old-u" },
    { role: "assistant", content: "old-a" },
    { role: "user", content: "big-u" },
  ];
  for (let index = 1; index <= stepCount; index += 1) {
    messages.push(...toolStep(`s${String(index)}`, resultChars));
  }
  messages.push({ role: "assistant", content: "big-final" });
  return messages;
}

test("targetTokens 超出时放弃 keepRecentTurns 保护,按目标预算保留整轮", async () => {
  const messages = longTurns(6, 700);
  const result = await compactMessages({
    messages,
    strategy: "truncate",
    keepRecentTurns: 4,
    keepRecentTokens: 100_000,
    targetTokens: 500,
    model: draftModel(),
  });

  assert.equal(result.removed, 8);
  assert.equal(result.messages[0]?.content, "t5-u");
  assert.equal(result.messages.length, 4);
});

test("targetTokens 未给出时行为与之前一致(不升级)", async () => {
  const result = await compactMessages({
    messages: longTurns(6, 700),
    strategy: "truncate",
    keepRecentTurns: 4,
    keepRecentTokens: 100_000,
    model: draftModel(),
  });

  assert.equal(result.removed, 0);
});

test("最近一轮单独超出 targetTokens 时在步骤边界切,保留该轮 user 与最近步骤且不拆 tool 对", async () => {
  const messages = monsterTurn(6, 1500);
  const result = await compactMessages({
    messages,
    strategy: "truncate",
    keepRecentTurns: 4,
    keepRecentTokens: 100_000,
    targetTokens: 1500,
    model: draftModel(),
  });

  assert.ok(result.removed > 2, `expected intra-turn removal, got ${String(result.removed)}`);
  assert.equal(result.messages[0]?.content, "big-u");
  assert.equal(result.messages[1]?.role, "assistant");
  const kept = result.messages;
  for (const [index, message] of kept.entries()) {
    if (message.role === "tool") {
      assert.equal(kept[index - 1]?.role, "assistant");
    }
  }
  assert.equal(kept.at(-1)?.content, "big-final");
  assert.ok(kept.length < messages.length - 2);
});

test("步骤边界切至少保留最后一个步骤", async () => {
  const messages = monsterTurn(3, 1500);
  const result = await compactMessages({
    messages,
    strategy: "truncate",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    targetTokens: 1,
    model: draftModel(),
  });

  assert.deepEqual(
    result.messages.map((message) => message.content),
    ["big-u", "big-final"],
  );
});

test("步骤边界切受 maxRemovedTranscriptMessages 约束", async () => {
  const messages = monsterTurn(6, 1500);
  const result = await compactMessages({
    messages,
    strategy: "truncate",
    keepRecentTurns: 4,
    keepRecentTokens: 100_000,
    targetTokens: 1500,
    maxRemovedTranscriptMessages: 4,
    model: draftModel(),
  });

  assert.ok(result.removed <= 4, `removed ${String(result.removed)} exceeds evidence cap`);
});

test("暂停在工具步骤后的轮内压缩不截断最后一个步骤的工具结果,只截断更早的", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "big-u" },
    ...toolStep("s1", 3000),
    ...toolStep("s2", 3000),
  ];
  const result = await compactMessages({
    messages,
    strategy: "truncate",
    keepRecentTurns: 4,
    keepRecentTokens: 100_000,
    model: draftModel(),
  });

  assert.equal(result.removed, 0);
  assert.equal(result.truncatedTools, 1);
  const tools = result.messages.filter((message) => message.role === "tool");
  assert.match(toolOutputValue(tools[0]), /已省略/);
  assert.doesNotMatch(toolOutputValue(tools[1]), /已省略/);
  assert.equal(toolOutputValue(tools[1]).length, 3000);
});

test("estimateMessagesTokens 对 file part 按固定图像常数估算而非 base64 长度", () => {
  const base64 = "A".repeat(1_400_000);
  const toolMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "roll__read_file",
        output: {
          type: "content",
          value: [
            { type: "text", text: "图像文件" },
            { type: "file", data: { type: "data", data: base64 }, mediaType: "image/png" },
          ],
        },
      },
    ],
  } as unknown as ModelMessage;
  const userMessage = {
    role: "user",
    content: [
      { type: "text", text: "看这张图" },
      { type: "file", data: base64, mediaType: "image/png" },
    ],
  } as unknown as ModelMessage;
  const estimate = estimateMessagesTokens([toolMessage, userMessage]);
  assert.ok(estimate < 10_000, `估算应为常数级，实际 ${String(estimate)}`);
  assert.ok(estimate > 2_000, `估算不应丢失 file part 本身的成本，实际 ${String(estimate)}`);
});
