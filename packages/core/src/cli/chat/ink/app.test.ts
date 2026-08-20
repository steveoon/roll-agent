import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { ChatApp } from "./app.ts";
import { HistoryItemView } from "./history-item.ts";
import { GLYPHS } from "../../utils/glyphs.ts";

type PendingUserInput = Extract<SessionEvent, { readonly type: "user-input-required" }>;
type UserInputResult = Parameters<AgentSession["resolveUserInput"]>[1];

function literalPattern(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

const AUTO_BADGE_PATTERN = literalPattern(`${GLYPHS.auto} auto`);

interface Sink {
  approved: string[];
  approvals?: Array<{ id: string; scope: "once" | "session" | undefined }>;
  rejected: string[];
  cancelled?: number;
  userInputAvailability?: boolean[];
  resolvedUserInputs?: Array<{
    requestId: PendingUserInput["requestId"];
    result: UserInputResult;
  }>;
  cancelledUserInputs?: Array<{
    requestId: PendingUserInput["requestId"];
    reason: string | undefined;
  }>;
}

interface MakeSessionOptions {
  readonly contextWindow?: number;
  readonly skills?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly source: string;
  }>;
}

function makeSession(
  send: (input: string) => AsyncIterable<SessionEvent>,
  sink: Sink,
  onCancel?: () => void,
  options?: MakeSessionOptions,
): AgentSession {
  return {
    id: "s1",
    getContextWindow() {
      return options?.contextWindow;
    },
    getSkillSummaries() {
      return options?.skills ?? [];
    },
    send,
    approve(id: string, scope?: "once" | "session") {
      sink.approved.push(id);
      sink.approvals ??= [];
      sink.approvals.push({ id, scope });
      return true;
    },
    reject(id: string) {
      sink.rejected.push(id);
      return true;
    },
    cancel() {
      sink.cancelled = (sink.cancelled ?? 0) + 1;
      onCancel?.();
      return true;
    },
    setUserInputAvailable(available: boolean) {
      sink.userInputAvailability ??= [];
      sink.userInputAvailability.push(available);
    },
    resolveUserInput(requestId: PendingUserInput["requestId"], result: UserInputResult) {
      sink.resolvedUserInputs ??= [];
      sink.resolvedUserInputs.push({ requestId, result });
      return true;
    },
    cancelUserInput(requestId: PendingUserInput["requestId"], reason?: string) {
      sink.cancelledUserInputs ??= [];
      sink.cancelledUserInputs.push({ requestId, reason });
      return true;
    },
    abort() {},
  } as unknown as AgentSession;
}

const ANSI_STYLE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const TYPE_SKILL = {
  name: "typescript-magician",
  description: "严格处理 TypeScript 类型",
  source: "user",
} as const;

function plain(frame: string): string {
  return frame.replace(ANSI_STYLE_PATTERN, "");
}

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  assert.fail("Timed out waiting for assertion");
}

test("ChatApp streams an assistant reply into history and shows status", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-start", messageId: "m" };
    yield { type: "text-delta", delta: "你好" };
    yield {
      type: "message-finish",
      text: "你好",
      totalUsage: { inputTokens: 10, outputTokens: 4 },
      sessionUsage: { totalTokens: 14 },
      contextInputTokens: 10,
    };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink, undefined, { contextWindow: 200000 }),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("hi");
  await delay(10);
  stdin.write("\r");
  await delay(40);

  const frame = lastFrame() ?? "";
  assert.match(frame, /你好/);
  assert.match(frame, /qwen/);
  assert.match(frame, /left/);
  assert.match(plain(frame), /qwen[^\n]*\n╭/);
  unmount();
});

test("ChatApp previews Markdown before the assistant stream finishes", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  let releaseFinish: (() => void) | undefined;
  const finishGate = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-start", messageId: "m" };
    yield { type: "text-delta", delta: "## 流式标题\n\n**正在加粗**\n\n- 第一项" };
    await finishGate;
    yield {
      type: "message-finish",
      text: "## 流式标题\n\n**正在加粗**\n\n- 第一项",
    };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  try {
    await delay(10);
    stdin.write("preview");
    await delay(10);
    stdin.write("\r");

    await waitFor(() => {
      const frame = plain(lastFrame() ?? "");
      assert.match(frame, /流式标题/);
      assert.match(frame, /正在加粗/);
      assert.match(frame, /• 第一项/);
      assert.doesNotMatch(frame, /## |\*\*/);
    });
  } finally {
    releaseFinish?.();
    await delay(40);
    unmount();
  }
});

test("ChatApp shows model-waiting status separately from the submitted user message", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-start", messageId: "m" };
    await delay(80);
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("刚才我不小心取消了，你重来一下");
  await delay(10);
  stdin.write("\r");
  await delay(20);

  assert.match(plain(lastFrame() ?? ""), /刚才我不小心取消了，你重来一下\n.*等待模型响应…/s);
  unmount();
});

test("ChatApp recalls recent submitted inputs with the up arrow", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    await delay(30);
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      initialHistory: [{ kind: "user", id: "history-first", text: "first" }],
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);

  stdin.write("second");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.deepEqual(submitted, ["second"]));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /Esc 中断本轮/));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /Enter 发送/));
  await delay(30);

  stdin.write("\x1b[A");
  await delay(10);
  stdin.write("\x1b[A");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.deepEqual(submitted, ["second", "first"]));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /Esc 中断本轮/));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /Enter 发送/));
  unmount();
});

for (const [label, escapeSequence] of [
  ["legacy VT", "\x1b"],
  ["kitty keyboard", "\x1b[27u"],
] as const) {
  test(`ChatApp ${label} Esc 中断执行中的工具`, async () => {
    const sink: Sink = { approved: [], rejected: [], cancelled: 0 };
    let releaseCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    async function* send(): AsyncIterable<SessionEvent> {
      yield { type: "message-start", messageId: "m" };
      yield {
        type: "tool-call",
        toolCallId: "c1",
        agentName: "roll",
        toolName: "powershell",
        input: { command: "Start-Sleep -Seconds 30" },
      };
      await cancellation;
      yield {
        type: "turn-cancelled",
        reason: "user",
        message: "已停止本轮操作。正在进行的任务也已请求停止。",
      };
    }
    const { stdin, lastFrame, unmount } = render(
      h(ChatApp, {
        session: makeSession(send, sink, () => releaseCancellation?.()),
        model: "qwen",
        onUserSubmit: () => {},
        onExit: () => {},
      }),
    );
    await delay(10);
    stdin.write("run");
    await delay(10);
    stdin.write("\r");
    await waitFor(() => assert.match(plain(lastFrame() ?? ""), /Esc 中断本轮/));

    stdin.write(escapeSequence);
    await waitFor(() => assert.equal(sink.cancelled, 1));
    await waitFor(() => assert.match(plain(lastFrame() ?? ""), /roll\.powershell.*已中断/s));
    assert.match(plain(lastFrame() ?? ""), /已停止本轮操作/);
    unmount();
  });
}

test("ChatApp Esc 中断 token streaming", async () => {
  const sink: Sink = { approved: [], rejected: [], cancelled: 0 };
  let releaseCancellation: (() => void) | undefined;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-start", messageId: "m" };
    yield { type: "text-delta", delta: "尚未完成的输出" };
    await cancellation;
    await delay(80);
    yield {
      type: "turn-cancelled",
      reason: "user",
      message: "已停止本轮回复。之前的对话会保留，你可以继续输入。",
    };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink, () => releaseCancellation?.()),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("stream");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /尚未完成的输出/));

  stdin.write("\x1b");
  await waitFor(() => assert.equal(sink.cancelled, 1));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /正在中断…/));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /已停止本轮回复/));
  assert.doesNotMatch(plain(lastFrame() ?? ""), /尚未完成的输出/);
  unmount();
});

test("turn-cancelled 窄宽度换行保持前缀列与正文列对齐", () => {
  const message =
    "已停止本轮操作。正在进行的任务也已请求停止。之前的对话和已完成进度会保留；部分已经完成的操作不会自动撤销，请检查结果。";
  for (const [reason, prefix] of [
    ["user", "■"],
    ["timeout", "⚠"],
    ["runtime", "✗"],
  ] as const) {
    const { lastFrame, unmount } = render(
      h(
        Box,
        { width: 40 },
        h(HistoryItemView, {
          item: { kind: "turn-cancelled", id: reason, reason, text: message },
        }),
      ),
    );
    const lines = plain(lastFrame() ?? "").split("\n");

    assert.ok(lines.length > 1);
    assert.equal(lines[0]?.slice(0, 2), `${prefix} `);
    for (const line of lines.slice(1)) {
      assert.match(line, /^ {2}\S/u);
    }
    assert.equal(lines.map((line) => line.slice(2)).join(""), message);
    unmount();
  }
});

test("ChatApp confirm flow shows the cleaned AI explanation and tool args, then approves on y", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "confirmation-required",
      approvalId: "a1",
      agentName: "browser-use-agent",
      toolName: "click_ref",
      input: { ref: "node-42" },
      explanation: "  点击目标按钮，\n继续完成当前任务\u0000  ",
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("go");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(lastFrame() ?? "", /执行 browser-use-agent\.click_ref/));
  assert.match(lastFrame() ?? "", /AI 说明：点击目标按钮， 继续完成当前任务/u);
  assert.match(lastFrame() ?? "", /ref: node-42/);
  const confirmationLines = plain(lastFrame() ?? "").split("\n");
  const optionRow = confirmationLines.findIndex(
    (line) => line.includes("Yes") && line.includes("No"),
  );
  assert.notEqual(optionRow, -1);
  assert.match(confirmationLines[optionRow + 1] ?? "", /^╰/u);
  await delay(100);

  stdin.write("y");
  await waitFor(() => assert.deepEqual(sink.approved, ["a1"]));
  unmount();
});

test("ChatApp confirm flow remembers approval for the session on 'a'", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "confirmation-required",
      approvalId: "a1",
      agentName: "browser-use-agent",
      toolName: "click_ref",
      input: { ref: "node-42" },
      sessionGrantLabel: "本会话内不再询问：修改工作目录内的文件",
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("go");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(lastFrame() ?? "", /执行 browser-use-agent\.click_ref/));
  await delay(100);

  stdin.write("a");
  await waitFor(() => assert.deepEqual(sink.approved, ["a1"]));
  assert.deepEqual(sink.approvals, [{ id: "a1", scope: "session" }]);
  assert.deepEqual(sink.rejected, []);
  unmount();
});

test("ChatApp Esc cancels a user input form without cancelling the turn", async () => {
  const sink: Sink = {
    approved: [],
    rejected: [],
    cancelled: 0,
    userInputAvailability: [],
    resolvedUserInputs: [],
    cancelledUserInputs: [],
  };
  const requestId = "00000000-0000-4000-8000-000000000185" as PendingUserInput["requestId"];
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "user-input-required",
      requestId,
      form: {
        title: "部署配置",
        controls: [
          {
            type: "text",
            id: "workspace",
            label: "目标 Workspace",
            required: true,
          },
        ],
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    yield { type: "message-finish", text: "已取消输入" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await waitFor(() => assert.deepEqual(sink.userInputAvailability, [true]));
  stdin.write("go");
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /目标 Workspace/));

  stdin.write("\x1b");
  await waitFor(() => assert.equal(sink.cancelledUserInputs?.length, 1));
  assert.deepEqual(sink.cancelledUserInputs, [{ requestId, reason: "用户取消" }]);
  assert.deepEqual(sink.resolvedUserInputs, []);
  assert.equal(sink.cancelled, 0);
  unmount();
  await delay(10);
  assert.deepEqual(sink.userInputAvailability, [true, false]);
});

test("ChatApp auto-approve never fills or submits user input", async () => {
  const sink: Sink = {
    approved: [],
    rejected: [],
    userInputAvailability: [],
    resolvedUserInputs: [],
    cancelledUserInputs: [],
  };
  const requestId = "00000000-0000-4000-8000-000000000186" as PendingUserInput["requestId"];
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "user-input-required",
      requestId,
      form: {
        title: "部署配置",
        controls: [
          {
            type: "text",
            id: "workspace",
            label: "目标 Workspace",
            required: true,
          },
        ],
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    yield { type: "message-finish", text: "完成" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("\x1b[Z");
  await waitFor(() => assert.match(lastFrame() ?? "", AUTO_BADGE_PATTERN));
  stdin.write("go");
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /目标 Workspace/));

  stdin.write("\x1b[Z");
  await delay(30);
  assert.deepEqual(sink.resolvedUserInputs, []);
  assert.deepEqual(sink.cancelledUserInputs, []);

  stdin.write("team-green");
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /确认提交/));
  stdin.write("\x1b[Z");
  await delay(30);
  assert.deepEqual(sink.resolvedUserInputs, []);
  stdin.write("\r");
  await waitFor(() => assert.equal(sink.resolvedUserInputs?.length, 1));
  assert.deepEqual(sink.resolvedUserInputs, [
    {
      requestId,
      result: {
        status: "submitted",
        values: [{ id: "workspace", value: "team-green" }],
      },
    },
  ]);
  unmount();
});

test("ChatApp expires a pending user input once without waiting for another key", async () => {
  const sink: Sink = {
    approved: [],
    rejected: [],
    cancelled: 0,
    resolvedUserInputs: [],
    cancelledUserInputs: [],
  };
  const requestId = "00000000-0000-4000-8000-000000000187" as PendingUserInput["requestId"];
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "user-input-required",
      requestId,
      form: {
        controls: [
          {
            type: "text",
            id: "workspace",
            label: "目标 Workspace",
            required: true,
          },
        ],
      },
      expiresAt: new Date(Date.now() + 80).toISOString(),
    };
    yield { type: "message-finish", text: "已超时" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("go");
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /目标 Workspace/));
  await waitFor(() => assert.equal(sink.cancelledUserInputs?.length, 1));

  assert.deepEqual(sink.cancelledUserInputs, [{ requestId, reason: "用户输入请求已超时" }]);
  assert.deepEqual(sink.resolvedUserInputs, []);
  assert.equal(sink.cancelled, 0);
  await delay(30);
  assert.equal(sink.cancelledUserInputs?.length, 1);
  unmount();
});

test("Shift+Tab enables auto mode and confirmations are approved silently", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "confirmation-required",
      approvalId: "a1",
      agentName: "browser-use-agent",
      toolName: "click_ref",
      input: {},
      explanation: "点击目标按钮并继续当前任务",
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, frames, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("\x1b[Z");
  await waitFor(() => assert.match(lastFrame() ?? "", AUTO_BADGE_PATTERN));
  stdin.write("go");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.deepEqual(sink.approved, ["a1"]));
  assert.ok(frames.every((frame) => !frame.includes("执行 browser-use-agent")));
  unmount();
});

test("Shift+Tab during a pending confirmation approves it immediately", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "confirmation-required",
      approvalId: "a1",
      agentName: "browser-use-agent",
      toolName: "click_ref",
      input: {},
      explanation: "点击目标按钮并继续当前任务",
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("go");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(lastFrame() ?? "", /执行 browser-use-agent\.click_ref/));
  assert.match(lastFrame() ?? "", /AI 说明：点击目标按钮并继续当前任务/u);
  await delay(100);

  stdin.write("\x1b[Z");
  await waitFor(() => assert.deepEqual(sink.approved, ["a1"]));
  assert.match(lastFrame() ?? "", AUTO_BADGE_PATTERN);
  unmount();
});

test("Shift+Tab twice turns auto mode back off and manual confirm returns", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "confirmation-required",
      approvalId: "a1",
      agentName: "browser-use-agent",
      toolName: "click_ref",
      input: {},
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("\x1b[Z");
  await waitFor(() => assert.match(lastFrame() ?? "", AUTO_BADGE_PATTERN));
  stdin.write("\x1b[Z");
  await waitFor(() => assert.doesNotMatch(lastFrame() ?? "", AUTO_BADGE_PATTERN));
  stdin.write("go");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(lastFrame() ?? "", /执行 browser-use-agent\.click_ref/));
  await delay(100);

  stdin.write("y");
  await waitFor(() => assert.deepEqual(sink.approved, ["a1"]));
  unmount();
});

test("kitty-encoded Shift+Tab toggles auto mode", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("\x1b[9;2u");
  await waitFor(() => assert.match(lastFrame() ?? "", AUTO_BADGE_PATTERN));
  unmount();
});

test("Shift+Tab in the slash popup toggles auto without completing", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/th");
  await delay(20);
  stdin.write("\x1b[Z");
  await delay(20);
  let frame = plain(lastFrame() ?? "");
  assert.match(frame, AUTO_BADGE_PATTERN);
  assert.doesNotMatch(frame, /› \/think/);
  stdin.write("\t");
  await delay(20);
  frame = plain(lastFrame() ?? "");
  assert.match(frame, /› \/think/);
  unmount();
});

test("/auto slash command toggles auto mode", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  for (const ch of "/auto") {
    stdin.write(ch);
  }
  await delay(20);
  stdin.write("\r");
  await waitFor(() => assert.match(lastFrame() ?? "", AUTO_BADGE_PATTERN));
  unmount();
});

test("ChatApp collapses committed inline thinking and never shows literal think tags", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "text-delta", delta: "<think>内部思考</think>最终答案" };
    yield { type: "message-finish", text: "<think>内部思考</think>最终答案" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("q");
  await delay(10);
  stdin.write("\r");
  await delay(50);
  const frame = lastFrame() ?? "";
  assert.match(frame, /最终答案/);
  assert.match(frame, /推理过程 · 4 字 · 已折叠/);
  assert.doesNotMatch(frame, /内部思考/);
  assert.doesNotMatch(frame, /<\/think>/);
  unmount();
});

test("ChatApp keeps inline thinking visible when thinking display is expanded", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "text-delta", delta: "<think>内部思考</think>最终答案" };
    yield { type: "message-finish", text: "<think>内部思考</think>最终答案" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      initialThinkingDisplay: "expanded",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("q");
  await delay(10);
  stdin.write("\r");
  await delay(50);
  const frame = lastFrame() ?? "";
  assert.match(frame, /最终答案/);
  assert.match(frame, /内部思考/);
  assert.doesNotMatch(frame, /已折叠/);
  assert.doesNotMatch(frame, /<\/think>/);
  unmount();
});

test("ChatApp streams provider reasoning separately from tool activity", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  let releaseReasoning: (() => void) | undefined;
  let releaseTool: (() => void) | undefined;
  const reasoningDone = new Promise<void>((resolve) => {
    releaseReasoning = resolve;
  });
  const toolDone = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-start", messageId: "m" };
    yield { type: "reasoning-start", reasoningId: "r1" };
    yield {
      type: "reasoning-delta",
      reasoningId: "r1",
      delta: "先检查输入状态，再定位工具调用边界。",
    };
    await reasoningDone;
    yield { type: "reasoning-end", reasoningId: "r1" };
    yield {
      type: "tool-call",
      toolCallId: "c1",
      agentName: "roll",
      toolName: "search",
      input: { query: "input state" },
    };
    await toolDone;
    yield {
      type: "tool-result",
      toolCallId: "c1",
      agentName: "roll",
      toolName: "search",
      output: "found",
      isError: false,
    };
    yield { type: "text-delta", delta: "已经定位并修复。" };
    yield { type: "message-finish", text: "已经定位并修复。" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("debug");
  await delay(10);
  stdin.write("\r");

  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /思考中…/);
    assert.match(frame, /先检查输入状态，再定位工具调用边界/);
    assert.match(frame, /推理过程\n\s*│ 先检查输入状态，再定位工具调用边界。\n\n.*思考中…/s);
    assert.match(frame, /思考中…[^\n]*\n╭/);
    assert.doesNotMatch(frame, /roll\.search/);
  });

  releaseReasoning?.();
  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /执行 roll\.search/);
    assert.match(frame, /推理过程/);
    assert.match(frame, /已折叠/);
    assert.doesNotMatch(frame, /先检查输入状态/);
    assert.match(frame, /已折叠\n\n\s+· roll\.search/);
    assert.doesNotMatch(frame, /已折叠\n\n\n/);
    assert.ok(frame.indexOf("已折叠") < frame.indexOf("roll.search"));
  });

  releaseTool?.();
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /已经定位并修复/));
  unmount();
});

test("ChatApp keeps committed reasoning fully visible when thinking display is expanded", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "reasoning-start", reasoningId: "r1" };
    yield {
      type: "reasoning-delta",
      reasoningId: "r1",
      delta: "先检查输入状态，再定位工具调用边界。",
    };
    yield { type: "reasoning-end", reasoningId: "r1" };
    yield { type: "text-delta", delta: "已经定位并修复。" };
    yield { type: "message-finish", text: "已经定位并修复。" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      initialThinkingDisplay: "expanded",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("debug");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /已经定位并修复/);
    assert.match(frame, /先检查输入状态，再定位工具调用边界/);
    assert.doesNotMatch(frame, /已折叠/);
  });
  unmount();
});

test("/show-think toggles committed reasoning between collapsed and expanded", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "reasoning-start", reasoningId: "r1" };
    yield { type: "reasoning-delta", reasoningId: "r1", delta: "内部推演过程" };
    yield { type: "reasoning-end", reasoningId: "r1" };
    yield { type: "text-delta", delta: "答案" };
    yield { type: "message-finish", text: "答案" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("q");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /已折叠/);
    assert.doesNotMatch(frame, /内部推演过程/);
  });
  // 等待 turn-end 落回 idle，否则 busy 阶段的输入会被禁用的输入框丢弃
  await delay(50);

  for (const ch of "/show-think on") {
    stdin.write(ch);
  }
  await delay(20);
  stdin.write("\r");
  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /已完成的思考将完整显示/);
    assert.match(frame, /内部推演过程/);
    assert.doesNotMatch(frame, /已折叠/);
  });

  for (const ch of "/show-think off") {
    stdin.write(ch);
  }
  await delay(20);
  stdin.write("\r");
  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /已折叠/);
    assert.doesNotMatch(frame, /内部推演过程/);
  });
  unmount();
});

test("/diff 切换 diff 折叠模式并给出提示", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "text-delta", delta: "好的" };
    yield { type: "message-finish", text: "好的" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);

  for (const ch of "/diff") {
    stdin.write(ch);
  }
  await delay(20);
  stdin.write("\r");
  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /完整显示/);
  });

  for (const ch of "/diff off") {
    stdin.write(ch);
  }
  await delay(20);
  stdin.write("\r");
  await waitFor(() => {
    const frame = plain(lastFrame() ?? "");
    assert.match(frame, /折叠为一行摘要/);
  });
  unmount();
});

test("ChatApp renders many tool rows in history", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    for (let i = 0; i < 5; i += 1) {
      yield {
        type: "tool-call",
        toolCallId: `c${String(i)}`,
        agentName: "browser-use-agent",
        toolName: `act-${String(i)}`,
        input: {},
      };
      yield {
        type: "tool-result",
        toolCallId: `c${String(i)}`,
        agentName: "browser-use-agent",
        toolName: `act-${String(i)}`,
        output: { ok: true },
        isError: false,
      };
    }
    yield { type: "text-delta", delta: "全部完成" };
    yield { type: "message-finish", text: "全部完成" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("run");
  await delay(10);
  stdin.write("\r");
  await delay(60);

  const frame = lastFrame() ?? "";
  assert.match(frame, /act-0/);
  assert.match(frame, /act-4/);
  assert.match(frame, /全部完成/);
  unmount();
});

test("ChatApp shows a slash popup that filters as you type", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/");
  await delay(20);
  let frame = lastFrame() ?? "";
  assert.match(frame, /\/compact/);
  assert.match(frame, /\/think/);
  stdin.write("th");
  await delay(20);
  frame = lastFrame() ?? "";
  assert.match(frame, /\/think/);
  assert.doesNotMatch(frame, /\/compact/);
  unmount();
});

test("ChatApp /skills lists loadable skills", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink, undefined, { skills: [TYPE_SKILL] }),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/skills");
  await delay(20);
  stdin.write("\r");
  await delay(20);

  const frame = plain(lastFrame() ?? "");
  assert.match(frame, /可加载 SKILL/);
  assert.match(frame, /\/typescript-magician/);
  assert.match(frame, /严格处理 TypeScript 类型/);
  unmount();
});

test("ChatApp completes skill names from the slash popup", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink, undefined, { skills: [TYPE_SKILL] }),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/typ");
  await delay(20);
  stdin.write("\t");
  await delay(20);

  assert.match(plain(lastFrame() ?? ""), /› \/typescript-magician/);
  unmount();
});

test("ChatApp 把显式 skill 原始输入交给 AgentSession，由 Harness 预加载", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const sent: string[] = [];
  const submitted: string[] = [];
  async function* send(input: string): AsyncIterable<SessionEvent> {
    sent.push(input);
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink, undefined, { skills: [TYPE_SKILL] }),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/typescript-magician 修一下类型");
  await delay(20);
  stdin.write("\r");
  await waitFor(() => assert.equal(sent.length, 1));

  assert.deepEqual(submitted, ["/typescript-magician 修一下类型"]);
  assert.equal(sent[0], "/typescript-magician 修一下类型");
  assert.match(plain(lastFrame() ?? ""), /\/typescript-magician 修一下类型/);
  unmount();
});

test("Ctrl+J inserts a newline instead of submitting", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  let sendCount = 0;
  async function* send(): AsyncIterable<SessionEvent> {
    sendCount += 1;
    yield { type: "message-finish", text: "" };
  }
  const { stdin, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("ab");
  await delay(10);
  stdin.write("\n");
  await delay(20);
  assert.equal(sendCount, 0);
  unmount();
});

test("ChatApp ignores leaked keyboard protocol response text", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("[?0u");
  await delay(20);
  assert.doesNotMatch(lastFrame() ?? "", /\[\?0u/);

  stdin.write("hi");
  await delay(10);
  stdin.write("\r");
  await delay(20);
  assert.deepEqual(submitted, ["hi"]);
  unmount();
});

test("Alt+. raises the thinking level in the status line", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  assert.match(lastFrame() ?? "", literalPattern(`${GLYPHS.think} medium`));
  stdin.write("\x1b[46;3u");
  await delay(20);
  assert.match(lastFrame() ?? "", literalPattern(`${GLYPHS.think} high`));
  unmount();
});

test("ChatApp seeds resumed conversation history", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      initialHistory: [
        { kind: "user", id: "h-0", text: "之前的问题" },
        { kind: "assistant", id: "h-1", text: "之前的回答" },
      ],
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(20);
  const frame = lastFrame() ?? "";
  assert.match(frame, /之前的问题/);
  assert.match(frame, /之前的回答/);
  unmount();
});

test("rapid char-by-char typing accumulates without dropping chars", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  for (const ch of "你abc好") {
    stdin.write(ch);
  }
  await delay(20);
  stdin.write("\r");
  await delay(20);
  assert.deepEqual(submitted, ["你abc好"]);
  unmount();
});

test("plain 'exit' is sent as a message; only /exit quits", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  let exited = false;
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {
        exited = true;
      },
    }),
  );
  await delay(10);
  stdin.write("exit");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => {
    assert.equal(exited, false);
    assert.deepEqual(submitted, ["exit"]);
  });
  unmount();

  const second = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {
        exited = true;
      },
    }),
  );
  await delay(10);
  // A real PTY may deliver the whole command and Enter in one input chunk, before React has
  // rendered a slash-active frame. The submitted value must still route through runSlash().
  second.stdin.write("/exit\r");
  await waitFor(() => assert.equal(exited, true));
  second.unmount();
});

test("ChatApp submits text corrected with arrow-key cursor editing", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("helo");
  await delay(10);
  stdin.write("\x1b[D");
  await delay(10);
  stdin.write("l");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.deepEqual(submitted, ["hello"]));
  unmount();
});

test("ChatApp slash popup arrows keep selecting candidates instead of moving the cursor", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/");
  await delay(20);
  const before = plain(lastFrame() ?? "").match(/❯ (\/\S+)/)?.[1];
  stdin.write("\x1b[B");
  await delay(20);
  const frame = plain(lastFrame() ?? "");
  const after = frame.match(/❯ (\/\S+)/)?.[1];
  assert.ok(before !== undefined && after !== undefined);
  assert.notEqual(after, before);
  assert.match(frame, /› \//);
  unmount();
});

test("ChatApp enter submits the whole multiline draft with cursor on an upper line", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("ab");
  await delay(10);
  stdin.write("\n");
  await delay(10);
  stdin.write("cd");
  await delay(10);
  stdin.write("\x1b[A");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.deepEqual(submitted, ["ab\ncd"]));
  unmount();
});

function switchableFakeSession(
  id: string,
  messages: readonly { role: string; content: string }[] = [],
): {
  readonly session: AgentSession;
  readonly sent: () => readonly string[];
  readonly isClosed: () => boolean;
} {
  let closed = false;
  const sent: string[] = [];
  const session = {
    id,
    send: (text: string) => {
      sent.push(text);
      return (async function* (): AsyncGenerator<never> {})();
    },
    compact: () => (async function* (): AsyncGenerator<never> {})(),
    cancel: () => false,
    approve: () => {},
    reject: () => {},
    close: async () => {
      closed = true;
    },
    getMessages: () => messages,
    getContextWindow: () => undefined,
    getSkillSummaries: () => [],
    setUserInputAvailable: () => {},
    resolveUserInput: () => {},
    cancelUserInput: () => {},
  } as unknown as AgentSession;
  return { session, sent: () => sent, isClosed: () => closed };
}

test("ChatApp switches sessions via /resume picker", async () => {
  const first = switchableFakeSession("s1");
  const second = switchableFakeSession("s2", [
    { role: "user", content: "旧消息" },
    { role: "assistant", content: "旧回复" },
  ]);
  const retired: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: first.session,
      model: "test-model",
      onUserSubmit: () => {},
      onExit: () => {},
      sessionSwitching: {
        loadItems: () => [{ id: "t2", title: "发布计划", meta: "2 小时前 · 2 条消息" }],
        resume: async () => second.session,
        onRetired: (threadId: string) => retired.push(threadId),
      },
    }),
  );
  await delay(20);
  stdin.write("/resume");
  await delay(20);
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /切换会话/);
  assert.match(lastFrame() ?? "", /发布计划/);
  stdin.write("\r");
  await delay(50);
  await waitFor(() => {
    assert.match(lastFrame() ?? "", /旧消息/);
    assert.equal(first.isClosed(), true);
    assert.deepEqual(retired, ["s1"]);
  });
  stdin.write("hello");
  await delay(20);
  stdin.write("\r");
  await delay(30);
  assert.deepEqual(second.sent(), ["hello"]);
  assert.deepEqual(first.sent(), []);
  unmount();
});

test("ChatApp keeps current session when resume fails", async () => {
  const first = switchableFakeSession("s1");
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: first.session,
      model: "test-model",
      onUserSubmit: () => {},
      onExit: () => {},
      sessionSwitching: {
        loadItems: () => [{ id: "t2", title: "发布计划", meta: "2 小时前 · 2 条消息" }],
        resume: async () => {
          throw new Error("线程不存在");
        },
        onRetired: () => {},
      },
    }),
  );
  await delay(20);
  stdin.write("/resume");
  await delay(20);
  stdin.write("\r");
  await delay(20);
  stdin.write("\r");
  await waitFor(() => {
    assert.match(lastFrame() ?? "", /切换失败：线程不存在/);
  });
  assert.equal(first.isClosed(), false);
  stdin.write("\x1b");
  await delay(30);
  stdin.write("hi");
  await delay(20);
  stdin.write("\r");
  await delay(30);
  assert.deepEqual(first.sent(), ["hi"]);
  unmount();
});

test("ChatApp reports notice when session switching is unavailable", async () => {
  const first = switchableFakeSession("s1");
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: first.session,
      model: "test-model",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(20);
  stdin.write("/resume");
  await delay(20);
  stdin.write("\r");
  await delay(30);
  assert.match(lastFrame() ?? "", /当前界面不支持会话切换/);
  unmount();
});

test("ChatApp 以绝对路径开头的输入按普通消息提交", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/Users/gt/yc/supplier2.0/AGENTS.md 依据规则审核仓库代码质量");
  await delay(20);
  assert.doesNotMatch(plain(lastFrame() ?? ""), /无匹配命令/);
  stdin.write("\r");
  await waitFor(() =>
    assert.deepEqual(submitted, ["/Users/gt/yc/supplier2.0/AGENTS.md 依据规则审核仓库代码质量"]),
  );
  assert.doesNotMatch(plain(lastFrame() ?? ""), /未知命令/);
  unmount();
});

test("ChatApp PTY 整串投递的路径输入也按普通消息提交", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/Users/gt/yc/AGENTS.md 审核\r");
  await waitFor(() => assert.deepEqual(submitted, ["/Users/gt/yc/AGENTS.md 审核"]));
  unmount();
});

test("ChatApp 未知命令提示后保留草稿", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const submitted: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/thnik on");
  await delay(20);
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /未知命令 \/thnik/));
  assert.match(plain(lastFrame() ?? ""), /\/thnik on/);
  assert.deepEqual(submitted, []);
  unmount();
});

test("ChatApp 输入命令参数时不渲染空弹窗", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("/think o");
  await delay(20);
  assert.doesNotMatch(plain(lastFrame() ?? ""), /无匹配命令/);
  unmount();
});

test("ChatApp Ctrl+T 释放鼠标上报并显示恢复提示", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, frames, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write(String.fromCharCode(20));
  await delay(20);
  assert.ok(frames.some((item) => plain(item).includes("鼠标已释放:选中即可复制")));
  assert.ok(frames.some((item) => plain(item).includes("Ctrl+T 恢复滚轮")));
  assert.ok(frames.some((item) => item.includes("[?1003l")));
  stdin.write(String.fromCharCode(20));
  await delay(20);
  stdin.write("x");
  await delay(20);
  assert.doesNotMatch(plain(lastFrame() ?? ""), /鼠标已释放/);
  unmount();
});

test("ChatApp Ctrl+Y 复制最后一轮对话并提示", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const copied: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-start", messageId: "m1" };
    yield { type: "text-delta", delta: "你好,我能帮什么?" };
    yield { type: "message-finish", text: "你好,我能帮什么?" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
      copyToClipboard: (text: string) => {
        copied.push(text);
        return Promise.resolve(true);
      },
    }),
  );
  await delay(10);
  stdin.write("hi");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /你好,我能帮什么\?/));
  stdin.write(String.fromCharCode(25));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /已复制本轮对话/));
  assert.deepEqual(copied, [
    "用户: hi\n\n助手: 你好,我能帮什么?\n\n---\n对话来自 roll-agent · npm i -g @roll-agent/core",
  ]);
  unmount();
});

test("ChatApp Ctrl+Y 无历史时提示暂无可复制", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const copied: string[] = [];
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
      copyToClipboard: (text: string) => {
        copied.push(text);
        return Promise.resolve(true);
      },
    }),
  );
  await delay(10);
  stdin.write(String.fromCharCode(25));
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /暂无可复制的消息/));
  assert.deepEqual(copied, []);
  unmount();
});

test("ChatApp 空输入按 ? 打开快捷键面板,再按 ? 关闭", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("?");
  await delay(20);
  let frame = plain(lastFrame() ?? "");
  assert.match(frame, /Ctrl\+Y {2}复制本轮对话/);
  assert.match(frame, /Ctrl\+T {2}释放\/恢复鼠标/);
  stdin.write("?");
  await delay(20);
  frame = plain(lastFrame() ?? "");
  assert.doesNotMatch(frame, /释放\/恢复鼠标/);
  unmount();
});

test("ChatApp 输入非空时 ? 作为普通字符进入草稿", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("a");
  await delay(10);
  stdin.write("?");
  await delay(20);
  const frame = plain(lastFrame() ?? "");
  assert.match(frame, /› a\?/);
  assert.doesNotMatch(frame, /释放\/恢复鼠标/);
  unmount();
});

test("ChatApp 首轮回复完成后提示 Ctrl+Y 复制", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-start", messageId: "m1" };
    yield { type: "text-delta", delta: "回答完毕" };
    yield { type: "message-finish", text: "回答完毕" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("问题");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /Ctrl\+Y 复制本轮对话/));
  unmount();
});

test("ChatApp 滚轮滚动后提示 Ctrl+T 释放鼠标", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      initialHistory: [
        { kind: "user", id: "u1", text: "旧消息" },
        { kind: "notice", id: "n1", text: "占位" },
      ],
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write(`${String.fromCharCode(27)}[<64;10;5M`);
  await delay(20);
  assert.match(plain(lastFrame() ?? ""), /Ctrl\+T 释放鼠标后可直接选中复制/);
  unmount();
});

test("ChatApp 已持久化的提示不再重复出现", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "message-finish", text: "" };
  }
  const shownAll = {
    isShown: () => true,
    markShown: () => {},
  };
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      initialHistory: [
        { kind: "user", id: "u1", text: "旧问题" },
        { kind: "assistant", id: "a1", text: "旧回答" },
      ],
      hintFlags: shownAll,
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(30);
  let frame = plain(lastFrame() ?? "");
  assert.doesNotMatch(frame, /Ctrl\+Y 复制本轮对话/);
  stdin.write(`${String.fromCharCode(27)}[<64;10;5M`);
  await delay(20);
  frame = plain(lastFrame() ?? "");
  assert.doesNotMatch(frame, /Ctrl\+T 释放鼠标/);
  unmount();
});
