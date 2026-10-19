import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession } from "./agent-session.ts";
import type { SessionEvent } from "../types/events.ts";

function done() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t" },
        { type: "text-delta" as const, id: "t", delta: "ok" },
        { type: "text-end" as const, id: "t" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}
async function collect(session: AgentSession, text = "accepted") {
  const events: SessionEvent[] = [];
  for await (const event of session.send(text)) events.push(event);
  return events;
}
for (const reason of ["cancel", "timeout", "failure"] as const) {
  test(`guard maintenance ${reason} preserves accepted input and truthfully reports request preparation`, async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return done();
      },
    });
    const session = new AgentSession({
      id: `guard-${reason}`,
      model,
      sources: [],
      maxSteps: 1,
      contextWindow: 100,
      ...(reason === "timeout" ? { turnTimeoutMs: 20 } : {}),
      compaction: {
        enabled: true,
        strategy: "truncate",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1,
      },
    });
    // Isolate cancellation and failure at the owned request-maintenance boundary.
    Object.defineProperty(session, "runCompaction", {
      configurable: true,
      value: async () => {
        if (reason === "failure") throw new Error("maintenance fixture failed");
        if (reason === "cancel") session.cancel();
        else await delay(40);
        return false;
      },
    });
    try {
      const events = await collect(session);
      assert.equal(calls, 0);
      assert.equal(
        session.getMessages().filter((m) => m.role === "user" && m.content === "accepted").length,
        1,
      );
      const budget = session.getRequestBudgetState();
      if (reason === "failure") {
        assert.ok(budget.comparison?.after);
        assert.equal(budget.comparison.spaceImproved, false);
        assert.equal(budget.preparedAttempts, 2);
      } else {
        assert.equal(budget.comparison?.after, undefined);
        assert.equal(budget.preparedAttempts, 1);
      }
      assert.ok(events.some((event) => event.type === "error" || event.type === "turn-cancelled"));
      session.switchModel({ model, contextWindow: 100000 });
      assert.ok((await collect(session, "next")).some((event) => event.type === "message-finish"));
      assert.equal(calls, 1);
    } finally {
      await session.close();
    }
  });
}
test("unknown window dispatches without fake capacity; disabled maintenance preserves policy", async () => {
  let calls = 0;
  let maintenanceCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return done();
    },
  });
  const session = new AgentSession({
    id: "unknown-window",
    model,
    sources: [],
    maxSteps: 1,
    compaction: {
      enabled: false,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });
  Object.defineProperty(session, "runCompaction", {
    value: async () => {
      maintenanceCalls += 1;
      return false;
    },
  });
  try {
    await collect(session);
    assert.equal(calls, 1);
    assert.equal(session.getRequestBudgetState().last?.windowSource, "unknown");
    assert.equal(session.getRequestBudgetState().last?.availableInputCeiling, undefined);
    session.switchModel({ model, contextWindow: 100 });
    const events = await collect(session, "saved input");
    assert.equal(calls, 1);
    assert.equal(maintenanceCalls, 0);
    assert.ok(events.some((event) => event.type === "error"));
    assert.equal(session.getMessages().at(-1)?.content, "saved input");
  } finally {
    await session.close();
  }
});
