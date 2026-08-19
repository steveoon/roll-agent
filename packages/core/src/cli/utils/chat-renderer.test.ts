import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
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

const DIFF_FIXTURE = {
  path: "a.txt",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  truncated: false,
} as const;

function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return run().then(
    () => {
      process.stderr.write = original;
      return out;
    },
    (error: unknown) => {
      process.stderr.write = original;
      throw error;
    },
  );
}

test("确认消息在有 diff 时内嵌 diff 头与正文而不是原始 edits JSON", async () => {
  let message = "";
  const renderer = new ChatRenderer(async (m) => {
    message = m;
    return false;
  });
  await renderer.handle(
    {
      type: "confirmation-required",
      approvalId: "ap-1",
      agentName: "roll",
      toolName: "edit_file",
      input: { file_path: "a.txt", edits: [{ old_string: "old", new_string: "new" }] },
      explanation: "修改 a.txt：1 处编辑",
      diff: DIFF_FIXTURE,
    },
    { approve() {}, reject() {} },
  );
  const plain = stripVTControlCharacters(message);
  assert.match(
    plain,
    /^执行 roll\.edit_file\?\nAI 说明：修改 a\.txt：1 处编辑\na\.txt {2}\+1 −1\n/u,
  );
  assert.match(plain, /-old/u);
  assert.match(plain, /\+new/u);
  assert.doesNotMatch(plain, /old_string/u);
});

test("tool-result 的 {text, diff} display 在 stderr 打印 diff，且受 /diff 折叠模式控制", async () => {
  const bigUnified = [
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1,50 +1,50 @@",
    ...Array.from({ length: 50 }, (_, i) => `-r${String(i)}`),
    ...Array.from({ length: 50 }, (_, i) => `+R${String(i)}`),
    "",
  ].join("\n");
  const big = { ...DIFF_FIXTURE, path: "b.txt", added: 50, removed: 50, unified: bigUnified };
  const renderer = new ChatRenderer(async () => true);
  const collapsed = await captureStderr(async () => {
    await renderer.handle(
      { type: "tool-call", toolCallId: "c1", agentName: "roll", toolName: "write_file", input: {} },
      { approve() {}, reject() {} },
    );
    await renderer.handle(
      {
        type: "tool-result",
        toolCallId: "c1",
        agentName: "roll",
        toolName: "write_file",
        output: "",
        isError: false,
        display: { text: "已写入 b.txt", diff: big },
      },
      { approve() {}, reject() {} },
    );
  });
  const collapsedPlain = stripVTControlCharacters(collapsed);
  assert.match(collapsedPlain, /b\.txt {2}\+50 −50/u);
  assert.match(collapsedPlain, /另 \d+ 行（\/diff on 展开）/u);
  renderer.setDiffDisplay("expanded");
  assert.equal(renderer.diffDisplay, "expanded");
  const expanded = await captureStderr(async () => {
    await renderer.handle(
      { type: "tool-call", toolCallId: "c2", agentName: "roll", toolName: "write_file", input: {} },
      { approve() {}, reject() {} },
    );
    await renderer.handle(
      {
        type: "tool-result",
        toolCallId: "c2",
        agentName: "roll",
        toolName: "write_file",
        output: "",
        isError: false,
        display: { text: "已写入 b.txt", diff: big },
      },
      { approve() {}, reject() {} },
    );
  });
  assert.doesNotMatch(stripVTControlCharacters(expanded), /另 \d+ 行/u);
  assert.match(stripVTControlCharacters(expanded), /\+R49/u);
});
