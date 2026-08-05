import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@roll-agent/runtime";
import { ChatRenderer, type ChatApprover } from "./chat-renderer.ts";
import type { ChatUserInputPrompt } from "./user-input-prompts.ts";

type UserInputRequiredEvent = Extract<SessionEvent, { readonly type: "user-input-required" }>;

function userInputEvent(expiresAt: string): UserInputRequiredEvent {
  return {
    type: "user-input-required",
    requestId: "006e39fd-f99b-4c5d-8896-3d969226291d" as UserInputRequiredEvent["requestId"],
    expiresAt,
    form: {
      controls: [
        {
          type: "text",
          id: "owner",
          label: "负责人",
          required: true,
        },
      ],
    },
  };
}

function recordingResponder(records: {
  readonly resolved: string[];
  readonly cancelled: Array<{ readonly requestId: string; readonly reason?: string }>;
}): ChatApprover {
  return {
    approve() {},
    reject() {},
    resolveUserInput(requestId) {
      records.resolved.push(requestId);
      return true;
    },
    cancelUserInput(requestId, reason) {
      records.cancelled.push({
        requestId,
        ...(reason !== undefined ? { reason } : {}),
      });
      return true;
    },
  };
}

test("user input deadline aborts the prompt and suppresses a late submitted result", async () => {
  const records = {
    resolved: [] as string[],
    cancelled: [] as Array<{ readonly requestId: string; readonly reason?: string }>,
  };
  let observedSignal: AbortSignal | undefined;
  const prompt: ChatUserInputPrompt = {
    async request(_form, signal) {
      observedSignal = signal;
      if (signal?.aborted !== true) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return { status: "submitted", values: [{ id: "owner", value: "late" }] };
    },
  };
  const renderer = new ChatRenderer(async () => false, undefined, undefined, prompt);
  const event = userInputEvent(new Date(Date.now() + 20).toISOString());

  await renderer.handle(event, recordingResponder(records));

  assert.equal(observedSignal?.aborted, true);
  assert.deepEqual(records.resolved, []);
  assert.deepEqual(records.cancelled, [
    { requestId: event.requestId, reason: "用户输入请求已超时" },
  ]);
});

test("expired boundary settles exactly once even when the prompt returns immediately", async () => {
  const records = {
    resolved: [] as string[],
    cancelled: [] as Array<{ readonly requestId: string; readonly reason?: string }>,
  };
  let observedSignal: AbortSignal | undefined;
  const prompt: ChatUserInputPrompt = {
    async request(_form, signal) {
      observedSignal = signal;
      return { status: "submitted", values: [{ id: "owner", value: "boundary" }] };
    },
  };
  const renderer = new ChatRenderer(async () => false, undefined, undefined, prompt);
  const event = userInputEvent(new Date(Date.now() - 1).toISOString());

  await renderer.handle(event, recordingResponder(records));

  assert.equal(observedSignal?.aborted, true);
  assert.equal(records.resolved.length + records.cancelled.length, 1);
  assert.deepEqual(records.cancelled, [
    { requestId: event.requestId, reason: "用户输入请求已超时" },
  ]);
});
