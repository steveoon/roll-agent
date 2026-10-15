import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import { estimatePreparedRequest } from "./request-budget.ts";
import type { SessionEvent } from "../types/events.ts";

const usage = (input = 10) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
});
function text(input = 10): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "done" },
    { type: "text-end", id: "t" },
    { type: "finish", usage: usage(input), finishReason: { unified: "stop", raw: "stop" } },
  ];
}
function stream(chunks: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
  };
}
async function drain(session: AgentSession, input = "work") {
  const events: SessionEvent[] = [];
  for await (const event of session.send(input)) {
    events.push(event);
    if (event.type === "confirmation-required") session.approve(event.approvalId);
  }
  return events;
}
const compaction = {
  enabled: true,
  strategy: "truncate" as const,
  threshold: 0.75,
  keepRecentTurns: 1,
  keepRecentTokens: 32,
};
function source(name: string, readOnly: boolean, execute: () => unknown): AgentToolSource {
  const client = new Client({ name: "fixture", version: "1" });
  Object.defineProperty(client, "callTool", { value: async () => execute() });
  return {
    agentName: "fixture",
    client,
    tools: [
      {
        tool: { name, description: name, inputSchema: { type: "object", properties: {} } },
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
      },
    ],
  };
}

test("initial SDK guard blocks capacity failure before provider, bounds preparations and later turn is usable", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return stream(text());
    },
  });
  const session = new AgentSession({
    id: "initial-guard",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 100,
    compaction,
  });
  try {
    const events = await drain(session);
    assert.equal(calls, 0);
    assert.ok(
      events.some(
        (event) =>
          event.type === "error" && /context_request_budget_unrecoverable/.test(event.message),
      ),
    );
    assert.ok(session.getRequestBudgetState().preparedAttempts <= 7);
    assert.ok(session.getRequestBudgetState().comparison?.after);
    assert.equal(session.getMessages().filter((m) => m.role === "user").length, 1);
    session.switchModel({ model, contextWindow: 100000 });
    assert.ok((await drain(session, "next")).some((event) => event.type === "message-finish"));
    assert.equal(calls, 1);
  } finally {
    await session.close();
  }
});

test("soft 75% target never becomes a hard rejection or repeated unchanged preparation loop", async () => {
  const payload = "x".repeat(12000);
  let calls = 0;
  let actual: LanguageModelV4CallOptions | undefined;
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      calls += 1;
      actual = params;
      return stream(text());
    },
  });
  const warm = new AgentSession({ id: "soft-guard", model, sources: [], maxSteps: 1 });
  await drain(warm, payload);
  const raw = warm.getRequestBudgetState().last!.rawInputEstimate;
  await warm.close();
  calls = 0;
  const session = new AgentSession({
    id: "soft-guard",
    model,
    sources: [],
    maxSteps: 1,
    contextWindow: Math.ceil(raw / 0.8),
    compaction,
  });
  try {
    const events = await drain(session, payload);
    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
    assert.ok(session.getRequestBudgetState().preparedAttempts <= 7);
    const budget = session.getRequestBudgetState().last!;
    assert.ok(
      budget.calibratedInputEstimate > budget.maintenanceTarget! &&
        budget.calibratedInputEstimate <= budget.availableInputCeiling!,
    );
    assert.equal(
      budget.rawInputEstimate,
      estimatePreparedRequest(actual!, { provider: model.provider, model: model.modelId }, 0)
        .rawInputEstimate,
    );
  } finally {
    await session.close();
  }
});

test("expired summary allowance still verifies and admits a fitting request above the advisory target", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date() });
  let calls = 0;
  let drafts = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return stream(text());
    },
    doGenerate: async ({ abortSignal }) => {
      drafts += 1;
      assert.ok(abortSignal);
      t.mock.timers.tick(1001);
      throw new DOMException("Summary deadline expired", "TimeoutError");
    },
  });
  const initialMessages = Array.from({ length: 20 }, () => [
    { role: "user" as const, content: "x".repeat(900) },
    { role: "assistant" as const, content: "old answer" },
  ]).flat();
  const warm = new AgentSession({ id: "warm", model, sources: [], maxSteps: 1, initialMessages });
  await drain(warm, "new goal");
  const raw = warm.getRequestBudgetState().last!.rawInputEstimate;
  await warm.close();
  calls = 0;
  const session = new AgentSession({
    id: "expiry",
    model,
    sources: [],
    maxSteps: 1,
    initialMessages,
    contextWindow: Math.ceil(raw / 0.8),
    compaction: { ...compaction, strategy: "summarize", timeoutMs: 1000, maxOutputTokens: 512 },
  });
  try {
    const events = await drain(session, "new goal");
    assert.deepEqual(
      events.filter((event) => event.type === "error"),
      [],
    );
    assert.equal(calls, 1);
    assert.equal(drafts, 1);
    assert.equal(events.at(-1)?.type, "message-finish");
    const episode = session.getMaintenanceEpisodes()[0];
    assert.equal(episode?.reason, "advisory_target_miss");
    assert.ok(episode?.after);
    assert.equal(episode.checkpointId, undefined, "expired work cannot commit");
  } finally {
    await session.close();
  }
});

test("intermediate finalized guard persists a completed real write and ledger before maintenance, never replays it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-guard-write-"));
  const store = new ThreadStore(dir);
  const thread = store.createThread();
  const file = join(dir, "once.txt");
  let writes = 0;
  let calls = 0;
  const prompts: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      calls += 1;
      prompts.push(params);
      return stream(
        calls === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "write", toolName: "fixture__write", input: "{}" },
              {
                type: "finish",
                usage: usage(),
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
              },
            ]
          : text(),
      );
    },
  });
  const session = new AgentSession({
    id: thread,
    model,
    maxSteps: 2,
    contextWindow: 12000,
    compaction,
    policy: new DefaultToolPolicy(),
    sources: [
      source("write", false, () => {
        writes += 1;
        writeFileSync(file, "one");
        return { content: [{ type: "text", text: "z".repeat(100000) }] };
      }),
    ],
    onAcceptInput: (id, input) => store.acceptTurnInput(thread, id, input),
    onPersist: (messages, options) => store.appendMessages(thread, messages, options),
    onReplace: (messages) => store.replaceMessages(thread, messages),
    onToolExecution: (record) => store.appendToolExecution(thread, record),
  });
  // Bypass only predictive stop in this fixture: exercise the actual finalized doStream guard.
  Object.defineProperty(session, "stopOnContextPressure", { value: () => () => false });
  try {
    const events = await drain(session);
    assert.equal(writes, 1);
    assert.equal(readFileSync(file, "utf8"), "one");
    assert.equal(calls, 1);
    assert.ok(session.getRequestBudgetState().preparedAttempts >= 3);
    assert.ok(
      events.some(
        (event) =>
          event.type === "error" && /context_request_budget_unrecoverable/.test(event.message),
      ),
      "latest Tool result remains protected by existing compactor; fail recoverably",
    );
    assert.ok(events.some((event) => event.type === "context-compacted"));
    assert.equal(events.filter((event) => event.type === "confirmation-required").length, 1);
    const ledger = store.listToolExecutions(thread);
    assert.equal(ledger.length, 1);
    assert.equal(store.listUncoveredToolExecutions(thread).length, 0);
    assert.equal(
      store.listTranscriptMessages(thread).filter((m) => m.message.role === "tool").length,
      1,
    );
    assert.equal(session.getRequestBudgetState().comparison!.spaceImproved, false);
    const executionId = ledger[0]?.id;
    session.switchModel({ model, contextWindow: 100000 });
    await drain(session, "continue without writing again");
    assert.equal(calls, 2);
    assert.equal(writes, 1);
    assert.equal(store.listToolExecutions(thread)[0]?.id, executionId);
    assert.ok(prompts[1]!.prompt.some((message) => message.role === "tool"));
    assert.equal(session.getToolExecutions()[0]?.id, ledger[0]?.id);
  } finally {
    await session.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest measured input, not earlier larger/cumulative usage, is reported as context occupancy", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () =>
      stream(
        ++calls === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "r", toolName: "fixture__read", input: "{}" },
              {
                type: "finish",
                usage: usage(10000),
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
              },
            ]
          : text(100),
      ),
  });
  const session = new AgentSession({
    id: "latest-usage",
    model,
    maxSteps: 2,
    sources: [source("read", true, () => ({ content: [{ type: "text", text: "small" }] }))],
  });
  try {
    const events = await drain(session);
    const finish = events.find((event) => event.type === "message-finish");
    assert.ok(finish?.type === "message-finish");
    assert.equal(finish.contextInputTokens, 100);
    assert.equal(finish.totalUsage?.inputTokens, 10100);
    await drain(session, "next");
    assert.ok(session.getRequestBudgetState().last!.calibrationResidual < 0);
    assert.equal(session.getRequestBudgetState().last?.measurementMatched, true);
    assert.equal(session.getRequestBudgetState().last?.latestMeasuredInput, 100);
  } finally {
    await session.close();
  }
});

test("unpresentable full evidence retains its tail and still admits a fitting SDK request", async () => {
  const marker = "CRITICAL_TAIL_DO_NOT_DROP";
  const initialMessages = [
    { role: "user" as const, content: "x".repeat(18000) + "\n" + marker },
    { role: "assistant" as const, content: "old answer" },
  ];
  let calls = 0;
  let request = "";
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      calls += 1;
      request = JSON.stringify(params.prompt);
      return stream(text());
    },
    doGenerate: async () => {
      throw new Error("oversized evidence must not be clipped to fit a summary");
    },
  });
  const warm = new AgentSession({
    id: "unpresentable-warm",
    model,
    sources: [],
    maxSteps: 1,
    initialMessages,
  });
  await drain(warm, "continue");
  const raw = warm.getRequestBudgetState().last!.rawInputEstimate;
  await warm.close();
  calls = 0;
  const session = new AgentSession({
    id: "unpresentable",
    model,
    sources: [],
    maxSteps: 1,
    initialMessages,
    contextWindow: Math.ceil(raw / 0.8),
    compaction: { ...compaction, strategy: "summarize" },
  });
  try {
    const events = await drain(session, "continue");
    assert.deepEqual(
      events.filter((event) => event.type === "error"),
      [],
    );
    assert.equal(calls, 1);
    assert.ok(request.includes(marker));
    assert.deepEqual(session.getMessages().slice(0, 2), initialMessages);
    assert.equal(session.getMaintenanceEpisodes()[0]?.reason, "advisory_target_miss");
  } finally {
    await session.close();
  }
});
