import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { compactMessages, findTurnBoundaries } from "./compactor.ts";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };

function summaryModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: STOP,
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      warnings: [],
    }),
  });
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
    model: summaryModel("SUMMARY-TEXT"),
  });

  assert.equal(result.removed, 4);
  assert.equal(result.kept, 5);
  assert.equal(result.messages[0]?.role, "user");
  assert.match(String(result.messages[0]?.content), /SUMMARY-TEXT/);
  assert.equal(result.messages[1]?.role, "assistant");
  assert.equal(result.messages[2]?.role, "user");
  assert.equal(result.messages[2]?.content, "t3-u");
  const toolResult = result.messages.find((m) => m.role === "tool");
  const toolCall = result.messages.find((m) => m.role === "assistant" && Array.isArray(m.content));
  assert.ok(toolResult && toolCall, "tool-call 与 tool-result 必须同时保留");
});

test("truncate 直接丢弃最早若干轮,不调用 LLM", async () => {
  const result = await compactMessages({
    messages: conversation(),
    strategy: "truncate",
    keepRecentTurns: 2,
    keepRecentTokens: 1,
    model: summaryModel("UNUSED"),
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
    model: summaryModel("UNUSED"),
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
    model: summaryModel("UNUSED"),
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
    model: summaryModel("UNUSED"),
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
    model: summaryModel("UNUSED"),
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
    model: summaryModel("UNUSED"),
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
        content: [{ type: "text", text: "摘要" }],
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
        content: [{ type: "text", text: "摘要" }],
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
