import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AgentSession } from "./agent-session.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import { ConfigurableToolPolicy } from "../policy/configurable-policy.ts";
import type { PolicyDecision, ToolPolicy } from "../types/policy.ts";
import type { SessionEvent } from "../types/events.ts";
import { ruleBasedClassifier } from "../bash/classifier/index.ts";
import type { ShellProfile } from "../bash/profile.ts";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };
const TOOL_CALLS: LanguageModelV4FinishReason = { unified: "tool-calls", raw: "tool-calls" };

const posixProfile: ShellProfile = {
  id: "posix",
  toolName: "bash",
  supportsSessionExec: true,
  supportsSafeCommandClassification: true,
  buildSpawn: (command, workdir, env) => ({
    file: "/bin/sh",
    args: ["-c", command],
    options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
  }),
  classify: (command, workdir) => ruleBasedClassifier.classify(command, workdir),
  killTree: async () => {},
  systemPromptHints: () => [],
};

function usage(inputTokens = 1, outputTokens = 1) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
}

function streamChunks(chunks: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function sequencedModel(steps: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
  });
}

function textStep(text: string, inputTokens = 1, outputTokens = 1): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: usage(inputTokens, outputTokens), finishReason: STOP },
  ];
}

function reasoningOnlyStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: text },
    { type: "reasoning-end", id: "r" },
    { type: "finish", usage: usage(1, 3), finishReason: STOP },
  ];
}

function streamErrorStep(message: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "error", error: message },
  ];
}

function toolCallStep(
  toolName: string,
  input: unknown,
  inputTokens = 1,
  outputTokens = 1,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", usage: usage(inputTokens, outputTokens), finishReason: TOOL_CALLS },
  ];
}

function textThenToolCallStep(
  text: string,
  toolName: string,
  input: unknown,
  inputTokens = 1,
  outputTokens = 1,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", usage: usage(inputTokens, outputTokens), finishReason: TOOL_CALLS },
  ];
}

function source(agentName: string, toolName: string, onCall?: () => void): AgentToolSource {
  const client = {
    callTool: async () => {
      onCall?.();
      return { content: [{ type: "text", text: "result-ok" }] };
    },
  } as unknown as Client;
  return {
    agentName,
    client,
    tools: [
      {
        tool: {
          name: toolName,
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

function testBashSettings(workdir: string) {
  return {
    workdir,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 600_000,
    turnTimeoutMs: 600_000,
    maxCaptureBytes: 1_048_576,
    maxModelOutputChars: 16_000,
    profile: posixProfile,
  };
}

test("AgentSession 流式输出纯文本并累积历史", async () => {
  const model = sequencedModel([textStep("你好世界")]);
  const session = new AgentSession({ id: "s1", model, sources: [], maxSteps: 4 });
  const events = await collect(session.send("hi"));

  assert.equal(events[0]?.type, "message-start");
  assert.equal(events.at(-1)?.type, "message-finish");
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish);
  assert.equal(finish.text, "你好世界");
  assert.ok(finish.totalUsage);
  assert.equal(finish.totalUsage.inputTokens, 1);
  assert.equal(finish.totalUsage.outputTokens, 1);
  assert.equal(session.getMessages()[0]?.role, "user");
});

test("AgentSession 跑通 agentic tool-call loop（无 policy 直接执行）", async () => {
  const model = sequencedModel([toolCallStep("echo-agent__echo", { q: "x" }), textStep("完成")]);
  const session = new AgentSession({
    id: "s2",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
  });
  const events = await collect(session.send("call echo"));

  const toolCall = events.find((event) => event.type === "tool-call");
  assert.ok(toolCall && toolCall.type === "tool-call");
  assert.equal(toolCall.agentName, "echo-agent");
  assert.equal(toolCall.toolName, "echo");
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
});

test("AgentSession 区分本轮累计输入和上下文输入压力", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 50),
    textStep("完成", 60),
  ]);
  const session = new AgentSession({
    id: "s2-usage",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
  });

  const events = await collect(session.send("call echo"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );

  assert.ok(finish);
  assert.equal(finish.totalUsage?.inputTokens, 110);
  assert.equal(finish.contextInputTokens, 60);
});

test("AgentSession 透出 cached 与 reasoning token", async () => {
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
          outputTokens: { total: 20, text: 12, reasoning: 8 },
        },
        finishReason: STOP,
      },
    ],
  ]);
  const session = new AgentSession({ id: "s-cache", model, sources: [], maxSteps: 2 });
  const events = await collect(session.send("hi"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );

  assert.ok(finish);
  assert.equal(finish.totalUsage?.cachedInputTokens, 40);
  assert.equal(finish.totalUsage?.reasoningTokens, 8);
  assert.equal(finish.sessionUsage?.cachedInputTokens, 40);
});

test("setProviderOptions only affects the next turn's streamText", async () => {
  const seen: Array<unknown> = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      seen.push(options.providerOptions);
      return streamChunks(textStep("ok"));
    },
  });
  const session = new AgentSession({
    id: "s-po",
    model,
    sources: [],
    maxSteps: 2,
    providerOptions: { alibaba: { enableThinking: false } },
  });
  await collect(session.send("a"));
  session.setProviderOptions({ alibaba: { enableThinking: true, thinkingBudget: 8192 } });
  await collect(session.send("b"));

  assert.deepEqual(seen[0], { alibaba: { enableThinking: false } });
  assert.deepEqual(seen[1], { alibaba: { enableThinking: true, thinkingBudget: 8192 } });
});

test("AgentSession 达到 maxSteps 上限且仍在调工具时标记 stoppedAtStepLimit", async () => {
  const model = sequencedModel([toolCallStep("echo-agent__echo", { q: "x" })]);
  const session = new AgentSession({
    id: "s-step-limit",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 2,
  });
  const events = await collect(session.send("loop"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );

  assert.ok(finish);
  assert.equal(finish.stoppedAtStepLimit, true);
});

test("AgentSession debugEvents 输出 turn/model 阶段日志", async () => {
  const model = sequencedModel([textStep("ok")]);
  const session = new AgentSession({
    id: "s2-debug",
    model,
    sources: [],
    maxSteps: 2,
    turnTimeoutMs: 60_000,
    debugEvents: true,
  });

  const events = await collect(session.send("debug"));
  const debugMessages = events
    .filter((event): event is Extract<SessionEvent, { type: "debug" }> => event.type === "debug")
    .map((event) => `${event.stage}:${event.message}`);

  assert.ok(debugMessages.includes("turn:start"));
  assert.ok(debugMessages.includes("model:calling streamText"));
  assert.ok(debugMessages.includes("model:first stream event"));
  assert.ok(debugMessages.includes("model:response messages ready"));
});

test("AgentSession 保持 thinking 但不持久化 reasoning-only 输出", async () => {
  const model = sequencedModel([reasoningOnlyStep("内部思考和被误放进 reasoning 的最终答复")]);
  const session = new AgentSession({
    id: "s2-reasoning-only",
    model,
    sources: [],
    maxSteps: 2,
  });

  const events = await collect(session.send("hi"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );

  assert.ok(finish);
  assert.equal(finish.text, "");
  assert.equal(finish.totalUsage?.outputTokens, 3);
  assert.deepEqual(session.getMessages(), [{ role: "user", content: "hi" }]);
});

test("AgentSession chat 调用注入最终回复必须走 text 通道的系统提示", async () => {
  let serializedPrompt = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      serializedPrompt = JSON.stringify(options.prompt);
      return streamChunks(textStep("ok"));
    },
  });
  const session = new AgentSession({
    id: "s2-system",
    model,
    sources: [],
    maxSteps: 2,
  });

  await collect(session.send("hi"));

  assert.match(serializedPrompt, /普通 text 输出通道/);
  assert.match(serializedPrompt, /不要复述用户输入/);
});

test("AgentSession 写类动作触发 confirmation，approve 后执行", async () => {
  let calls = 0;
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
    textStep("已发送"),
  ]);
  const session = new AgentSession({
    id: "s3",
    model,
    sources: [source("msg-agent", "send_message", () => (calls += 1))],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("需要")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId);
    }
  }

  const confirmation = events.find((event) => event.type === "confirmation-required");
  assert.ok(confirmation && confirmation.type === "confirmation-required");
  assert.equal(confirmation.toolName, "send_message");
  assert.equal(calls, 1);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
});

test("AgentSession reject 后终止当前 turn，不让模型重复调用工具", async () => {
  let calls = 0;
  const model = sequencedModel([
    textThenToolCallStep("需要", "msg-agent__send_message", { q: "hi" }),
    textStep("好的"),
  ]);
  const session = new AgentSession({
    id: "s4",
    model,
    sources: [source("msg-agent", "send_message", () => (calls += 1))],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("需要")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.reject(event.approvalId, "用户取消");
    }
  }

  assert.equal(calls, 0);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === true);
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish);
  assert.equal(finish.text, "已取消执行: 用户取消");
  assert.deepEqual(
    events
      .filter(
        (event): event is Extract<SessionEvent, { type: "text-delta" }> =>
          event.type === "text-delta",
      )
      .map((event) => event.delta),
    ["已取消执行: 用户取消"],
  );
  assert.equal(events.filter((event) => event.type === "tool-call").length, 1);
  assert.equal(session.getMessages().at(-1)?.role, "assistant");
  assert.equal(session.getMessages().at(-1)?.content, "已取消执行: 用户取消");
});

test("AgentSession policy deny 直接拒绝并终止当前 turn", async () => {
  let calls = 0;
  const denyPolicy: ToolPolicy = {
    check(): PolicyDecision {
      return { action: "deny", reason: "禁止" };
    },
  };
  const model = sequencedModel([toolCallStep("x-agent__do_it", { q: "v" }), textStep("收到")]);
  const session = new AgentSession({
    id: "s5",
    model,
    sources: [source("x-agent", "do_it", () => (calls += 1))],
    maxSteps: 8,
    policy: denyPolicy,
  });

  const events = await collect(session.send("do it"));
  assert.equal(calls, 0);
  assert.equal(
    events.some((event) => event.type === "confirmation-required"),
    false,
  );
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === true);
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish);
  assert.equal(finish.text, "策略拒绝执行: 禁止");
  assert.equal(session.getMessages().at(-1)?.content, "策略拒绝执行: 禁止");
});

test("AgentSession abort 中途确认不悬挂且回滚当前 turn", async () => {
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
    textStep("done"),
  ]);
  const session = new AgentSession({
    id: "s6",
    model,
    sources: [source("msg-agent", "send_message")],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("send hi")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.abort();
    }
  }

  assert.ok(events.some((event) => event.type === "confirmation-required"));
  assert.ok(events.some((event) => event.type === "error"));
  assert.equal(
    events.some((event) => event.type === "message-finish"),
    false,
  );
  assert.equal(session.getMessages().length, 0);
});

test("AgentSession 超阈值自动压缩(reactive,truncate)并回调 onReplace", async () => {
  const model = sequencedModel([textStep("a"), textStep("b"), textStep("c")]);
  let replaced: number | undefined;
  const session = new AgentSession({
    id: "c1",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 1,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: (messages) => {
      replaced = messages.length;
    },
  });

  await collect(session.send("t1"));
  await collect(session.send("t2"));
  const events = await collect(session.send("t3"));

  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.equal(compacted.strategy, "truncate");
  assert.equal(compacted.removed, 2);
  assert.equal(compacted.beforeInputTokens, 1);
  assert.equal(replaced, 2);
  assert.equal(events.at(-1)?.type, "message-finish");
});

test("AgentSession 累计输入超阈值但上下文输入未超阈值时不自动压缩", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 50),
    textStep("done", 60),
    textStep("after"),
  ]);
  const session = new AgentSession({
    id: "c1-aggregate-pressure",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 100,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const first = await collect(session.send("tool loop"));
  const firstFinish = first.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(firstFinish?.totalUsage?.inputTokens, 110);
  assert.equal(firstFinish?.contextInputTokens, 60);

  const second = await collect(session.send("next"));
  const compacted = second.find((event) => event.type === "context-compacted");
  assert.equal(compacted, undefined);
  assert.equal(second.at(-1)?.type, "message-finish");
});

test("AgentSession 上下文输入超阈值时下轮自动压缩", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 50),
    textStep("done", 60),
    textStep("after"),
  ]);
  const session = new AgentSession({
    id: "c1-context-pressure",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 70,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const first = await collect(session.send("tool loop"));
  const firstFinish = first.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(firstFinish?.totalUsage?.inputTokens, 110);
  assert.equal(firstFinish?.contextInputTokens, 60);

  const second = await collect(session.send("next"));
  const compacted = second.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.equal(compacted.beforeInputTokens, 60);
  assert.equal(compacted.removed, 4);
  assert.equal(second.at(-1)?.type, "message-finish");
});

test("AgentSession context 长度错误后立即压缩历史,下一轮可恢复", async () => {
  const model = sequencedModel([
    streamErrorStep("context_length_exceeded: prompt is too long"),
    textStep("recovered"),
  ]);
  let replaced: readonly unknown[] | undefined;
  const session = new AgentSession({
    id: "c1-overflow",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: (messages) => {
      replaced = messages;
    },
  });

  const failed = await collect(session.send("too much"));
  assert.ok(failed.some((event) => event.type === "error"));
  assert.equal(
    failed.some((event) => event.type === "message-finish"),
    false,
  );
  const compacted = failed.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.equal(compacted.removed, 2);
  assert.equal(replaced?.length, 2);
  assert.equal(session.getMessages().length, 2);

  const recovered = await collect(session.send("retry"));
  assert.equal(
    recovered.some((event) => event.type === "context-compacted"),
    false,
  );
  assert.equal(recovered.at(-1)?.type, "message-finish");
});

test("AgentSession summarize 自动压缩失败时降级 truncate 且不继续原始历史", async () => {
  const steps = [textStep("a"), textStep("b"), textStep("c")];
  let index = 0;
  let generateCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
    doGenerate: async () => {
      generateCalls += 1;
      throw new Error("summary failed: context_length_exceeded");
    },
  });
  const session = new AgentSession({
    id: "c1-fallback",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 1,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  await collect(session.send("t1"));
  await collect(session.send("t2"));
  const events = await collect(session.send("t3"));

  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.strategy, "truncate");
  assert.equal(compacted.removed, 2);
  assert.equal(generateCalls, 1);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.equal(events.at(-1)?.type, "message-finish");
});

test("AgentSession replace 持久化失败时不替换内存历史", async () => {
  const original = [
    { role: "user" as const, content: "old-1" },
    { role: "assistant" as const, content: "answer-1" },
    { role: "user" as const, content: "old-2" },
    { role: "assistant" as const, content: "answer-2" },
  ];
  const session = new AgentSession({
    id: "c1-replace-fail",
    model: sequencedModel([]),
    sources: [],
    maxSteps: 2,
    initialMessages: original,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: () => {
      throw new Error("persist failed");
    },
  });

  const events = await collect(session.compact("manual"));

  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.message, /persist failed/);
  assert.deepEqual([...session.getMessages()], original);
});

test("AgentSession compact iterator 提前关闭时取消 summary 且不替换历史", async () => {
  const original = [
    { role: "user" as const, content: "old-1" },
    { role: "assistant" as const, content: "answer-1" },
    { role: "user" as const, content: "old-2" },
    { role: "assistant" as const, content: "answer-2" },
  ];
  let resolveGenerateStarted: () => void = () => undefined;
  let resolveGenerateReleased: () => void = () => undefined;
  let resolveGenerateSettled: () => void = () => undefined;
  const generateStarted = new Promise<void>((resolve) => {
    resolveGenerateStarted = resolve;
  });
  const generateReleased = new Promise<void>((resolve) => {
    resolveGenerateReleased = resolve;
  });
  const generateSettled = new Promise<void>((resolve) => {
    resolveGenerateSettled = resolve;
  });
  let abortObserved = false;
  let replaceCalls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          abortObserved = true;
          resolveGenerateReleased();
        },
        { once: true },
      );
      if (options.abortSignal?.aborted) {
        abortObserved = true;
        resolveGenerateReleased();
      }
      resolveGenerateStarted();
      await generateReleased;
      resolveGenerateSettled();
      return {
        content: [{ type: "text", text: "SUMMARY-TEXT" }],
        finishReason: STOP,
        usage: usage(5, 3),
        warnings: [],
      };
    },
  });
  const session = new AgentSession({
    id: "c1-compact-abort",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: original,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: () => {
      replaceCalls += 1;
    },
  });

  const iterator = session.compact("manual")[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "compaction-start");
  await generateStarted;

  await iterator.return?.();
  await generateSettled;

  assert.equal(abortObserved, true);
  assert.equal(replaceCalls, 0);
  assert.deepEqual([...session.getMessages()], original);
});

test("AgentSession 手动 /compact 即使 enabled=false 也生效", async () => {
  const model = sequencedModel([textStep("a"), textStep("b")]);
  const session = new AgentSession({
    id: "c2",
    model,
    sources: [],
    maxSteps: 2,
    compaction: {
      enabled: false,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  await collect(session.send("t1"));
  await collect(session.send("t2"));
  const events = await collect(session.compact("manual"));

  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "manual");
  assert.equal(compacted.removed, 2);
  assert.equal(session.getMessages().length, 2);
});

test("AgentSession 累计 session token 用量并随 message-finish 上报", async () => {
  const model = sequencedModel([textStep("x"), textStep("y")]);
  const session = new AgentSession({ id: "c3", model, sources: [], maxSteps: 2 });

  await collect(session.send("a"));
  const events = await collect(session.send("b"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish?.sessionUsage);
  assert.equal(finish.sessionUsage.inputTokens, 2);
  assert.equal(finish.sessionUsage.outputTokens, 2);
  assert.equal(session.getSessionUsage().inputTokens, 2);
});

test("AgentSession 拒绝同一 session 并发 send，避免 emit/gate 状态串线", async () => {
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
    textStep("done"),
  ]);
  const session = new AgentSession({
    id: "s7",
    model,
    sources: [source("msg-agent", "send_message")],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const iterator = session.send("send hi")[Symbol.asyncIterator]();
  let firstConfirmationSeen = false;
  while (!firstConfirmationSeen) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === "confirmation-required") {
      firstConfirmationSeen = true;
    }
  }

  await assert.rejects(async () => {
    await session.send("second")[Symbol.asyncIterator]().next();
  }, /active turn/);

  session.abort();
  let drained = false;
  while (!drained) {
    const next = await iterator.next();
    drained = next.done === true;
  }
});

test(
  "bash 工具：模型调用 roll__bash 产出 delta 与 tool-result 事件",
  { skip: process.platform === "win32" },
  async () => {
    const { tmpdir } = await import("node:os");
    const model = sequencedModel([
      toolCallStep("roll__bash", { command: "echo session-bash" }),
      textStep("完成"),
    ]);
    const session = new AgentSession({
      id: "bash-1",
      model,
      sources: [],
      maxSteps: 5,
      policy: new ConfigurableToolPolicy({
        defaultMode: "auto",
        overrides: { "roll.bash": "auto" },
      }),
      bash: {
        profile: posixProfile,
        workdir: tmpdir(),
        defaultTimeoutMs: 10_000,
        maxTimeoutMs: 600_000,
        turnTimeoutMs: 600_000,
        maxCaptureBytes: 1_048_576,
        maxModelOutputChars: 16_000,
      },
    });

    const events: SessionEvent[] = [];
    for await (const event of session.send("跑一下 echo")) {
      events.push(event);
    }

    const toolCall = events.find((event) => event.type === "tool-call");
    assert.equal(toolCall?.type, "tool-call");
    assert.equal(toolCall.agentName, "roll");
    assert.equal(toolCall.toolName, "bash");

    const deltas = events.filter((event) => event.type === "tool-output-delta");
    assert.ok(deltas.length >= 1);
    assert.ok(
      deltas.some(
        (event) => event.type === "tool-output-delta" && event.delta.includes("session-bash"),
      ),
    );

    const toolResult = events.find((event) => event.type === "tool-result");
    assert.equal(toolResult?.type, "tool-result");
    assert.equal(toolResult.isError, false);
    assert.ok(JSON.stringify(toolResult.output).includes("Exit code: 0"));
  },
);

test(
  "bash 工具 E2E：工作区外 pattern 文件触发确认，工作区内 pattern 文件自动执行",
  { skip: process.platform === "win32" },
  async () => {
    const workdir = mkdtempSync(join(tmpdir(), "roll-bash-e2e-work-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "roll-bash-e2e-outside-"));
    try {
      writeFileSync(join(workdir, "haystack.txt"), "needle\nother\n");
      writeFileSync(join(workdir, "patterns.txt"), "needle\n");
      const outsidePattern = join(outsideDir, "patterns.txt");
      writeFileSync(outsidePattern, "needle\n");

      const unsafeSession = new AgentSession({
        id: "bash-e2e-unsafe",
        model: sequencedModel([
          toolCallStep("roll__bash", {
            command: `grep -f ${outsidePattern} haystack.txt`,
          }),
          textStep("不应继续执行"),
        ]),
        sources: [],
        maxSteps: 5,
        policy: new DefaultToolPolicy(),
        bashClassifier: ruleBasedClassifier,
        bash: testBashSettings(workdir),
      });
      const unsafeEvents: SessionEvent[] = [];
      for await (const event of unsafeSession.send("用工作区外 pattern 文件 grep")) {
        unsafeEvents.push(event);
        if (event.type === "confirmation-required") {
          unsafeSession.reject(event.approvalId);
        }
      }
      assert.ok(unsafeEvents.some((event) => event.type === "confirmation-required"));
      const denied = unsafeEvents.find((event) => event.type === "tool-result");
      assert.equal(denied?.type, "tool-result");
      assert.equal(denied.isError, true);
      assert.ok(JSON.stringify(denied.output).includes("已取消执行"));
      unsafeSession.abort();

      const safeSession = new AgentSession({
        id: "bash-e2e-safe",
        model: sequencedModel([
          toolCallStep("roll__bash", { command: "grep -f patterns.txt haystack.txt" }),
          textStep("完成"),
        ]),
        sources: [],
        maxSteps: 5,
        policy: new DefaultToolPolicy(),
        bashClassifier: ruleBasedClassifier,
        bash: testBashSettings(workdir),
      });
      const safeEvents = await collect(safeSession.send("用工作区内 pattern 文件 grep"));
      assert.ok(!safeEvents.some((event) => event.type === "confirmation-required"));
      const result = safeEvents.find((event) => event.type === "tool-result");
      assert.equal(result?.type, "tool-result");
      assert.equal(result.isError, false);
      assert.ok(JSON.stringify(result.output).includes("needle"));
      assert.ok(JSON.stringify(result.output).includes("Exit code: 0"));
      safeSession.abort();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  },
);

test("未配置 bash 时工具不存在", async () => {
  const session = new AgentSession({
    id: "no-bash",
    model: sequencedModel([textStep("hi")]),
    sources: [],
    maxSteps: 3,
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("hi")) {
    events.push(event);
  }
  assert.ok(!events.some((event) => event.type === "tool-call"));
});

function fakeSkillLibrary(
  name: string,
  content: string,
): import("@roll-agent/core/skills/library").SkillLibrary {
  const summary = { name, description: "测试 skill", source: "user" } as const;
  return {
    list: () => [summary],
    load: (requested) =>
      requested === name ? { summary, content, referencePaths: [] } : undefined,
    loadReference: () => undefined,
  };
}

test("applyAgentRefresh 后新 agent 工具与新 system prompt 从下一轮生效", async () => {
  let capturedSystem: string | undefined;
  let index = 0;
  const steps = [toolCallStep("new-agent__probe", { q: "x" }), textStep("完成")];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const first = options.prompt[0];
      if (first && first.role === "system") {
        capturedSystem = first.content;
      }
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
  });
  let calls = 0;
  const session = new AgentSession({
    id: "refresh-1",
    model,
    sources: [source("old-agent", "noop")],
    maxSteps: 8,
    systemPrompt: "OLD_PROMPT",
  });

  session.applyAgentRefresh({
    source: source("new-agent", "probe", () => (calls += 1)),
    systemPrompt: "NEW_PROMPT",
  });

  const events = await collect(session.send("call new agent"));
  assert.equal(capturedSystem, "NEW_PROMPT");
  assert.equal(calls, 1);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
});

test("applyAgentRefresh 注入 skill library 后 roll__skill 可用", async () => {
  const model = sequencedModel([
    toolCallStep("roll__skill", { name: "new-skill" }),
    textStep("ok"),
  ]);
  const session = new AgentSession({ id: "refresh-2", model, sources: [], maxSteps: 8 });

  session.applyAgentRefresh({
    source: source("new-agent", "probe"),
    skillLibrary: fakeSkillLibrary("new-skill", "SKILL BODY 内容"),
    systemPrompt: "NEW_PROMPT",
  });

  const events = await collect(session.send("load skill"));
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
  assert.deepEqual(
    session.getSkillSummaries().map((skill) => skill.name),
    ["new-skill"],
  );
});

test("applyAgentRefresh 对同名 agent 幂等，不产生带后缀的重复工具", async () => {
  const model = sequencedModel([textStep("noop")]);
  const session = new AgentSession({
    id: "refresh-3",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 4,
  });

  session.applyAgentRefresh({
    source: source("echo-agent", "echo"),
    systemPrompt: "NEW_PROMPT",
  });

  const events = await collect(session.send("hi"));
  assert.ok(events.some((event) => event.type === "message-finish"));
});

test("agent_install 工具无 policy 也强制确认，批准后热刷新生效", async () => {
  const model = sequencedModel([
    toolCallStep("roll__agent_install", { agent: "probe" }),
    textStep("装好了"),
  ]);
  let installed = 0;
  const session = new AgentSession({
    id: "install-1",
    model,
    sources: [],
    maxSteps: 8,
    agentInstall: {
      catalog: [{ shortName: "probe", description: "测试 agent" }],
      install: async (shortName, report) => {
        installed += 1;
        report(`安装 ${shortName}...`);
        return {
          outcome: {
            ok: true,
            agentName: "probe-agent",
            missingEnv: [],
            refreshApplied: false,
          },
          refresh: {
            source: source("probe-agent", "run"),
            systemPrompt: "REFRESHED_PROMPT",
          },
        };
      },
    },
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("install probe")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId);
    }
  }

  const confirmation = events.find((event) => event.type === "confirmation-required");
  assert.ok(confirmation && confirmation.type === "confirmation-required");
  assert.equal(confirmation.toolName, "agent_install");
  assert.equal(installed, 1);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
  assert.match(JSON.stringify(toolResult.output), /下一轮对话开始可用/);
});

test("agent_install 被拒绝时不执行安装", async () => {
  const model = sequencedModel([
    toolCallStep("roll__agent_install", { agent: "probe" }),
    textStep("好的"),
  ]);
  let installed = 0;
  const session = new AgentSession({
    id: "install-2",
    model,
    sources: [],
    maxSteps: 8,
    agentInstall: {
      catalog: [{ shortName: "probe", description: "测试 agent" }],
      install: async () => {
        installed += 1;
        return {
          outcome: { ok: true, agentName: "probe-agent", missingEnv: [], refreshApplied: false },
        };
      },
    },
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("install probe")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.reject(event.approvalId, "不装了");
    }
  }

  assert.equal(installed, 0);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === true);
  assert.match(JSON.stringify(toolResult.output), /已取消执行/);
});
