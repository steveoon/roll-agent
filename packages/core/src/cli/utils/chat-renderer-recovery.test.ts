import assert from "node:assert/strict";
import test from "node:test";
import { ChatRenderer } from "./chat-renderer.ts";
import { stripVTControlCharacters } from "node:util";

test("basic renderer never prints a discarded draft and returns to streaming for other providers", async (t) => {
  let output = "";
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  t.mock.method(process.stderr, "write", () => true);
  const renderer = new ChatRenderer(async () => false);
  const responder = { approve() {}, reject() {} };
  await renderer.handle({ type: "message-start", messageId: "m" }, responder);
  await renderer.handle({ type: "model-step-start" }, responder);
  await renderer.handle({ type: "text-delta", delta: "discarded draft" }, responder);
  assert.equal(output, "");
  await renderer.handle({ type: "model-recovery", attempt: 1 }, responder);
  await renderer.handle({ type: "model-step-start" }, responder);
  await renderer.handle({ type: "text-delta", delta: "completed answer" }, responder);
  await renderer.handle({ type: "step-finish", finishReason: "stop" }, responder);
  await renderer.handle({ type: "message-finish", text: "completed answer" }, responder);
  assert.equal(output, "completed answer\n");
  await renderer.handle({ type: "message-start", messageId: "other" }, responder);
  await renderer.handle({ type: "text-delta", delta: "live" }, responder);
  assert.equal(output, "completed answer\nlive");
  await renderer.handle({ type: "message-finish", text: "live" }, responder);
});

test("basic recovery buffer discards terminal drafts and flushes late successful text exactly once", async (t) => {
  let output = "";
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  t.mock.method(process.stderr, "write", () => true);
  const renderer = new ChatRenderer(async () => false);
  const responder = { approve() {}, reject() {} };
  for (const terminal of [
    { type: "error", stage: "execute", message: "limit reached" },
    { type: "turn-cancelled", reason: "user", message: "cancelled" },
  ] as const) {
    await renderer.handle({ type: "message-start", messageId: "m" }, responder);
    await renderer.handle({ type: "model-step-start" }, responder);
    await renderer.handle({ type: "text-delta", delta: "discarded" }, responder);
    await renderer.handle(terminal, responder);
  }
  assert.equal(output, "");
  await renderer.handle({ type: "message-start", messageId: "success" }, responder);
  await renderer.handle({ type: "model-step-start" }, responder);
  await renderer.handle({ type: "text-delta", delta: "first" }, responder);
  await renderer.handle({ type: "step-finish", finishReason: "tool-calls" }, responder);
  await renderer.handle({ type: "model-step-start" }, responder);
  await renderer.handle({ type: "step-finish", finishReason: "stop" }, responder);
  await renderer.handle({ type: "text-delta", delta: "late echo" }, responder);
  await renderer.handle({ type: "message-finish", text: "firstlate echo" }, responder);
  assert.equal(output, "firstlate echo\n");
});

test("basic renderer preserves cancelled tool facts through recovery without a failure marker", async (t) => {
  let output = "";
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    output += stripVTControlCharacters(String(chunk));
    return true;
  });
  const renderer = new ChatRenderer(async () => false);
  const responder = { approve() {}, reject() {} };
  try {
    for (const executionState of ["not_executed", "outcome_unknown"] as const) {
      await renderer.handle(
        { type: "tool-call", toolCallId: "c", agentName: "fixture", toolName: "write", input: {} },
        responder,
      );
      output = "";
      await renderer.handle(
        {
          type: "tool-result",
          toolCallId: "c",
          agentName: "fixture",
          toolName: "write",
          outcome: { kind: "cancelled", reason: "runtime", executionState },
          display: "cancelled",
          output: "cancelled",
          isError: true,
        },
        responder,
      );
      await renderer.handle({ type: "model-recovery", attempt: 1 }, responder);
      assert.match(output, /fixture\.write/);
      assert.match(output, executionState === "not_executed" ? /未执行/ : /结果待确认/);
      assert.doesNotMatch(output, /[✔✖✓✗]/);
    }
  } finally {
    await renderer.handle(
      { type: "turn-cancelled", reason: "user", message: "cancelled" },
      responder,
    );
  }
});

test("basic renderer settles pending tool spinners on error and cannot print them in a later turn", async (t) => {
  let output = "";
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    output += stripVTControlCharacters(String(chunk));
    return true;
  });
  const renderer = new ChatRenderer(async () => false);
  const responder = { approve() {}, reject() {} };
  try {
    await renderer.handle(
      { type: "tool-call", toolCallId: "c", agentName: "fixture", toolName: "write", input: {} },
      responder,
    );
    output = "";
    await renderer.handle(
      { type: "error", stage: "execute", message: "ledger unavailable" },
      responder,
    );
    assert.match(output, /fixture\.write.*结果待确认/);
    assert.doesNotMatch(output, /未执行/);
    output = "";
    await renderer.handle(
      {
        type: "tool-output-delta",
        toolCallId: "c",
        agentName: "fixture",
        toolName: "write",
        stream: "stdout",
        delta: "late output",
      },
      responder,
    );
    await renderer.handle(
      { type: "turn-cancelled", reason: "user", message: "next turn cancelled" },
      responder,
    );
    assert.doesNotMatch(output, /fixture\.write|late output/);
  } finally {
    await renderer.handle(
      { type: "turn-cancelled", reason: "user", message: "cancelled" },
      responder,
    );
  }
});
