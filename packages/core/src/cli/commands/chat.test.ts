import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { runJsonTurn } from "./chat.ts";

function fakeSession(events: readonly SessionEvent[]): AgentSession {
  return {
    id: "session-1",
    async *send() {
      for (const event of events) {
        yield event;
      }
    },
    reject() {
      return true;
    },
  } as unknown as AgentSession;
}

test("runJsonTurn exposes step and total token usage", async () => {
  const result = await runJsonTurn(
    fakeSession([
      { type: "text-delta", delta: "OK" },
      {
        type: "step-finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      {
        type: "message-finish",
        text: "OK",
        totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
    ]),
    "hi",
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "OK");
  assert.deepEqual(result.stepUsages, [
    {
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  ]);
  assert.deepEqual(result.totalUsage, { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
});
