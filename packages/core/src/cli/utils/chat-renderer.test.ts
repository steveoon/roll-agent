import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { SessionEvent } from "@roll-agent/runtime";
import { ChatRenderer, paginateApprovalReview, type ChatApprover } from "./chat-renderer.ts";
import type { ChatUserInputPrompt } from "./user-input-prompts.ts";
import stringWidth from "string-width";

test("clack review pages preserve long changes and fit terminal rows and columns", () => {
  const review = "context\n".repeat(2000) + "界".repeat(200) + "FINAL_REVIEW_MARKER";
  for (const [columns, rows] of [
    [40, 16],
    [80, 24],
  ]) {
    assert.ok(columns !== undefined && rows !== undefined);
    const pages = paginateApprovalReview(review, columns, rows);
    assert.ok(pages.length > 1);
    assert.equal(pages.join("\n").replaceAll("\n", ""), review.replaceAll("\n", ""));
    for (const page of pages) {
      assert.ok(page.split("\n").length <= rows - 10);
      assert.ok(page.split("\n").every((line) => stringWidth(line) <= columns - 4));
    }
    assert.ok(pages.at(-1)?.includes("FINAL_REVIEW_MARKER"));
  }
});

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

test("permission deadline aborts confirmation, suppresses late Yes and settles once", async () => {
  const decisions: string[] = [];
  let observed: AbortSignal | undefined;
  const renderer = new ChatRenderer(async (_message, signal) => {
    observed = signal;
    if (!signal?.aborted) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return true;
  });
  await renderer.handle(
    {
      type: "confirmation-required",
      approvalId: "deadline",
      agentName: "fixture",
      toolName: "test",
      input: {},
      expiresAt: new Date(Date.now() + 30).toISOString(),
    },
    {
      approve: () => {
        decisions.push("approved");
      },
      reject: (_id, reason) => {
        decisions.push(reason ?? "rejected");
      },
    },
  );
  assert.equal(observed?.aborted, true);
  assert.equal(observed?.reason instanceof Error && observed.reason.message, "审批请求已超时");
  assert.deepEqual(decisions, ["审批请求已超时"]);
});

test("permission rejects expired/invalid before opening UI and keeps missing-deadline compatibility", async () => {
  for (const expiresAt of [undefined, new Date(Date.now() - 10).toISOString(), "invalid"]) {
    let prompts = 0;
    const decisions: string[] = [];
    const renderer = new ChatRenderer(async () => {
      prompts++;
      return true;
    });
    await renderer.handle(
      {
        type: "confirmation-required",
        approvalId: "compat",
        agentName: "fixture",
        toolName: "test",
        input: {},
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
      {
        approve: () => {
          decisions.push("approved");
        },
        reject: (_id, reason) => {
          decisions.push(reason ?? "rejected");
        },
      },
    );
    assert.equal(prompts, expiresAt === undefined ? 1 : 0);
    assert.deepEqual(decisions, [
      expiresAt === undefined
        ? "approved"
        : expiresAt === "invalid"
          ? "审批请求截止时间无效"
          : "审批请求已超时",
    ]);
  }
});

test("permission checks wall clock at the click boundary and clears its timer on normal decision", async () => {
  const deadline = Date.now() + 60_000;
  const decisions: string[] = [];
  let observed: AbortSignal | undefined;
  const renderer = new ChatRenderer(async (_message, signal) => {
    observed = signal;
    mock.method(Date, "now", () => deadline);
    return true;
  });
  try {
    await renderer.handle(
      {
        type: "confirmation-required",
        approvalId: "race",
        agentName: "fixture",
        toolName: "test",
        input: {},
        expiresAt: new Date(deadline).toISOString(),
      },
      {
        approve: () => {
          decisions.push("approved");
        },
        reject: (_id, reason) => {
          decisions.push(reason ?? "rejected");
        },
      },
    );
    assert.deepEqual(decisions, ["审批请求已超时"]);
    // Date advanced without timer dispatch: hasExpired must still catch the late Yes.
    assert.equal(observed?.aborted, false);
  } finally {
    mock.restoreAll();
  }
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

for (const reason of ["auto", "manual"] as const) {
  test(`${reason} zero-progress compaction reports no reduction on stderr`, async () => {
    const renderer = new ChatRenderer(async () => false);
    const output = await captureStderr(async () => {
      await renderer.handle(
        {
          type: "context-compacted",
          reason,
          strategy: "summarize",
          removed: 0,
          kept: 44,
          beforeInputTokens: 1_000_000,
        },
        { approve() {}, reject() {} },
      );
    });
    assert.match(output, /未减少上下文/u);
    assert.match(output, /已保留原上下文/u);
    assert.doesNotMatch(output, /无需压缩|保留策略|安全检查|超时|失败/u);
  });

  for (const [failure, expected] of [
    [{ reason: "timeout", timeoutMs: 300_000 }, /压缩超时（等待上限 300 秒）/u],
    [{ reason: "error" }, /压缩失败/u],
  ] as const) {
    test(`${reason} ${failure.reason} compaction reports its cause on stderr`, async () => {
      const renderer = new ChatRenderer(async () => false);
      const output = await captureStderr(async () => {
        await renderer.handle(
          {
            type: "context-compacted",
            reason,
            strategy: "summarize",
            removed: 0,
            kept: 44,
            failure,
          },
          { approve() {}, reject() {} },
        );
      });
      assert.match(output, expected);
      assert.match(output, reason === "auto" ? /自动压缩/u : /手动压缩/u);
      assert.match(output, /已保留原上下文/u);
      assert.doesNotMatch(output, /保留策略|安全检查/u);
      if (failure.reason === "error") assert.doesNotMatch(output, /超时/u);
    });
  }
}

test("确认消息在有 diff 时内嵌 diff 头与正文而不是原始 edits JSON", async () => {
  let message = "";
  let fullReview: string | undefined;
  const renderer = new ChatRenderer(async (m, _signal, fullDiff) => {
    message = m;
    fullReview = fullDiff;
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
      fullDiff: `${"context\n".repeat(2000)}FINAL_CHANGE`,
    },
    { approve() {}, reject() {} },
  );
  const plain = stripVTControlCharacters(message);
  assert.match(
    plain,
    /^执行 roll\.edit_file\?\nAI 说明：修改 a\.txt：1 处编辑\na\.txt {2}\+1 −1\n/u,
  );
  assert.match(plain, /1 - old/u);
  assert.match(plain, /1 \+ new/u);
  assert.doesNotMatch(plain, /old_string/u);
  assert.ok(fullReview !== undefined && fullReview.length > 12_000);
  assert.match(fullReview, /FINAL_CHANGE/u);
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
  assert.match(collapsedPlain, /另 60 行（\/diff on 展开）/u);
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
  assert.match(stripVTControlCharacters(expanded), /50 \+ R49/u);
});

test("usage display follows the session context window after a model reload", async () => {
  const renderer = new ChatRenderer(async () => false, 1_000);
  let window: number | undefined = 200_000;
  const responder: ChatApprover = { approve() {}, reject() {}, getContextWindow: () => window };
  const event: SessionEvent = { type: "message-finish", text: "", contextInputTokens: 10_000 };
  const known = await captureStderr(() => renderer.handle(event, responder));
  assert.match(known, /200k/u);
  window = undefined;
  const unknown = await captureStderr(() => renderer.handle(event, responder));
  assert.doesNotMatch(unknown, /ctx /u);
});
