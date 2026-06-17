import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3FinishReason, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AgentSession } from "./agent-session.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import type { PolicyDecision, ToolPolicy } from "../types/policy.ts";
import type { SessionEvent } from "../types/events.ts";

const STOP: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" };
const TOOL_CALLS: LanguageModelV3FinishReason = { unified: "tool-calls", raw: "tool-calls" };

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function streamChunks(chunks: LanguageModelV3StreamPart[]) {
  return {
    stream: simulateReadableStream<LanguageModelV3StreamPart>({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function sequencedModel(steps: LanguageModelV3StreamPart[][]): MockLanguageModelV3 {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
  });
}

function textStep(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: usage(), finishReason: STOP },
  ];
}

function toolCallStep(toolName: string, input: unknown): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
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
  for await (const event of session.send("send hi")) {
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

test("AgentSession reject 后不调用 callTool，LLM 收到取消", async () => {
  let calls = 0;
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
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
  for await (const event of session.send("send hi")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.reject(event.approvalId, "用户取消");
    }
  }

  assert.equal(calls, 0);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === true);
});

test("AgentSession policy deny 直接拒绝，不询问不执行", async () => {
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
