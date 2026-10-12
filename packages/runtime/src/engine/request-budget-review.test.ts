import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession } from "./agent-session.ts";
import { RequestBudgetTracker } from "./request-budget.ts";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { SessionEvent } from "../types/events.ts";
const usage = (input: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
});
function text(input = 100) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t" },
        { type: "text-delta" as const, id: "t", delta: "done" },
        { type: "text-end" as const, id: "t" },
        {
          type: "finish" as const,
          usage: usage(input),
          finishReason: { unified: "stop" as const, raw: "stop" },
        },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}
async function collect(session: AgentSession, prompt: string) {
  const events: SessionEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}
const compaction = {
  enabled: true,
  strategy: "truncate" as const,
  threshold: 0.75,
  keepRecentTurns: 1,
  keepRecentTokens: 1000,
};

test("capability schema refresh invalidates ordinary residual and still dispatches smaller new goal", async () => {
  let calls = 0;
  const session = new AgentSession({
    id: "review-schema-refresh",
    sources: [],
    maxSteps: 2,
    contextWindow: 10000,
    compaction: { ...compaction, enabled: false },
    model: new MockLanguageModelV4({ doStream: async () => text(++calls === 1 ? 9000 : 100) }),
  });
  try {
    await collect(session, "first");
    session.setUserInputAvailable(true);
    const events = await collect(session, "second small goal");
    assert.equal(calls, 2);
    assert.ok(events.some((e) => e.type === "message-finish"));
    assert.equal(session.getRequestBudgetState().last?.measurementMatched, false);
    assert.equal(session.getRequestBudgetState().last?.calibrationResidual, 0);
  } finally {
    await session.close();
  }
});
test("unknown window overflow cannot redispatch a larger complete request after checkpoint", async () => {
  let calls = 0;
  const session = new AgentSession({
    id: "review-unknown-overflow",
    sources: [],
    maxSteps: 2,
    compaction: { ...compaction, keepRecentTokens: 1 },
    initialMessages: [
      { role: "user", content: "old small goal" },
      { role: "assistant", content: "old small reply" },
    ],
    model: new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          throw new APICallError({
            message: "maximum context length exceeded",
            url: "https://mock.invalid",
            requestBodyValues: {},
            statusCode: 400,
            isRetryable: false,
          });
        }
        return text();
      },
    }),
  });
  try {
    const events = await collect(session, "new goal");
    assert.equal(calls, 1);
    assert.ok(events.some((e) => e.type === "error"));
    const comparison = session.getRequestBudgetState().comparison;
    assert.ok(comparison?.after);
    assert.equal(comparison.spaceImproved, false);
    assert.ok(comparison.after.rawInputEstimate >= comparison.before.rawInputEstimate);
  } finally {
    await session.close();
  }
});
test("cancelled owner leaves missing after even while a different turn is preparing", () => {
  const tracker = new RequestBudgetTracker();
  const settings = { provider: "mock", model: "fixture" };
  const params = { prompt: [{ role: "system" as const, content: "system" }] };
  const before = tracker.prepare(params, settings, "shape", "turn-a");
  tracker.beginMaintenance(before, "turn-a");
  tracker.abandonMaintenance("turn-a");
  tracker.prepare(params, settings, "shape", "turn-b");
  assert.equal(tracker.view().comparison?.before.fingerprint, before.fingerprint);
  assert.equal(tracker.view().comparison?.after, undefined);
  assert.equal(tracker.view().comparison?.savedTokens, undefined);
});

test("real cancelled maintenance cannot be finalized at the next turn's first SDK prepare", async () => {
  const transitions: ReturnType<RequestBudgetTracker["view"]>[] = [];
  class ObservedTracker extends RequestBudgetTracker {
    override prepare(
      params: LanguageModelV4CallOptions,
      settings: Parameters<RequestBudgetTracker["prepare"]>[1],
      context: string,
      owner = "local",
    ) {
      const budget = super.prepare(params, settings, context, owner);
      transitions.push(this.view());
      return budget;
    }
  }
  const tracker = new ObservedTracker();
  const session = new AgentSession({
    id: "review-cancel-transition",
    sources: [],
    maxSteps: 2,
    contextWindow: 12000,
    compaction,
    model: new MockLanguageModelV4({ doStream: async () => text() }),
  });
  Object.defineProperty(session, "requestBudgets", { value: tracker });
  let cancelFirst = true;
  Object.defineProperty(session, "runCompaction", {
    value: async () => {
      if (cancelFirst) {
        cancelFirst = false;
        session.cancel();
      }
      return false;
    },
  });
  Object.defineProperty(session, "runAutoCompactionPasses", { value: async () => false });
  try {
    await collect(session, "X".repeat(29000));
    const before = tracker.view().comparison!.before;
    assert.equal(tracker.view().comparison?.after, undefined);
    const count = transitions.length;
    await collect(session, "different small goal");
    assert.ok(transitions.length > count);
    const next = transitions[count]!;
    assert.equal(next.comparison?.before.fingerprint, before.fingerprint);
    assert.equal(
      next.comparison?.after,
      undefined,
      "inspect first transition before a new maintenance can overwrite it",
    );
  } finally {
    await session.close();
  }
});
