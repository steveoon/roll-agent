import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { runJsonTurn, runRepl } from "./chat.ts";

function fakeSession(events: readonly SessionEvent[], contextWindow?: number): AgentSession {
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
    getContextWindow() {
      return contextWindow;
    },
  } as unknown as AgentSession;
}

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
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
        contextInputTokens: 3,
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
  assert.equal(result.status === "completed" ? result.contextInputTokens : undefined, 3);
});

test("runJsonTurn exposes session usage and context window", async () => {
  const result = await runJsonTurn(
    fakeSession(
      [
        { type: "text-delta", delta: "OK" },
        {
          type: "message-finish",
          text: "OK",
          totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
          sessionUsage: { inputTokens: 40, outputTokens: 50, totalTokens: 90 },
          contextInputTokens: 4,
        },
      ],
      200_000,
    ),
    "hi",
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" ? result.sessionUsage : undefined, {
    inputTokens: 40,
    outputTokens: 50,
    totalTokens: 90,
  });
  assert.equal(result.status === "completed" ? result.contextWindow : undefined, 200_000);
  assert.equal(result.status === "completed" ? result.contextInputTokens : undefined, 4);
});

test("runJsonTurn exposes context compaction events", async () => {
  const result = await runJsonTurn(
    fakeSession([
      {
        type: "context-compacted",
        reason: "auto",
        strategy: "truncate",
        removed: 2,
        kept: 4,
        beforeInputTokens: 90,
      },
      { type: "text-delta", delta: "OK" },
      {
        type: "message-finish",
        text: "OK",
        totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
    ]),
    "hi",
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" ? result.compactions : undefined, [
    {
      reason: "auto",
      strategy: "truncate",
      removed: 2,
      kept: 4,
      beforeInputTokens: 90,
    },
  ]);
});

test("runRepl keeps the prompt stream available around confirmation prompts", async () => {
  const input = new PassThrough();
  const sentMessages: string[] = [];
  const approved: string[] = [];
  const confirmationMessages: string[] = [];
  const session = {
    id: "session-1",
    async *send(message: string) {
      sentMessages.push(message);
      yield {
        type: "confirmation-required",
        approvalId: "approval-1",
        agentName: "browser-use-agent",
        toolName: "click_ref",
        input: {},
      } satisfies SessionEvent;
      yield { type: "message-finish", text: "done" } satisfies SessionEvent;
    },
    approve(approvalId: string) {
      approved.push(approvalId);
      return true;
    },
    reject() {
      return true;
    },
    getContextWindow() {
      return undefined;
    },
  } as unknown as AgentSession;
  const store = {
    updateTitle() {},
    countMessages() {
      return 1;
    },
    deleteThread() {},
  } as unknown as Parameters<typeof runRepl>[1];

  const done = runRepl(session, store, false, {
    input,
    output: sink(),
    confirm: async (message) => {
      confirmationMessages.push(message);
      return true;
    },
  });
  input.write("run\n");
  await delay(10);
  input.write("exit\n");
  input.end();

  await done;

  assert.deepEqual(sentMessages, ["run"]);
  assert.deepEqual(confirmationMessages, ["执行 browser-use-agent.click_ref?"]);
  assert.deepEqual(approved, ["approval-1"]);
});
