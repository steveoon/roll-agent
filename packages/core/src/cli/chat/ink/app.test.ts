import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { ChatApp } from "./app.ts";
import { GLYPHS } from "../../utils/glyphs.ts";

function literalPattern(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

const AUTO_BADGE_PATTERN = literalPattern(`${GLYPHS.auto} auto`);

interface Sink {
  approved: string[];
  rejected: string[];
  cancelled?: number;
}

function makeSession(
  send: (input: string) => AsyncIterable<SessionEvent>,
  sink: Sink,
  onCancel?: () => void,
): AgentSession {
  return {
    id: "s1",
    getContextWindow() {
      return 200000;
    },
    send,
    approve(id: string) {
      sink.approved.push(id);
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
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: 200000,
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
  unmount();
});

test("ChatApp separates the thinking indicator from the submitted user message", async () => {
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
      contextWindow: undefined,
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("刚才我不小心取消了，你重来一下");
  await delay(10);
  stdin.write("\r");
  await delay(20);

  assert.match(lastFrame() ?? "", /刚才我不小心取消了，你重来一下\n\n.*思考中…/s);
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
        message: "已取消本轮；正在运行的工具已收到中断请求。",
      };
    }
    const { stdin, lastFrame, unmount } = render(
      h(ChatApp, {
        session: makeSession(send, sink, () => releaseCancellation?.()),
        model: "qwen",
        contextWindow: undefined,
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
    assert.match(plain(lastFrame() ?? ""), /已取消本轮/);
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
    yield { type: "turn-cancelled", reason: "user", message: "已取消本轮。" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink, () => releaseCancellation?.()),
      model: "qwen",
      contextWindow: undefined,
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
  await waitFor(() => assert.match(plain(lastFrame() ?? ""), /已取消本轮/));
  assert.doesNotMatch(plain(lastFrame() ?? ""), /尚未完成的输出/);
  unmount();
});

test("ChatApp confirm flow shows tool args and approves on y", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield {
      type: "confirmation-required",
      approvalId: "a1",
      agentName: "browser-use-agent",
      toolName: "click_ref",
      input: { ref: "node-42" },
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: undefined,
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(10);
  stdin.write("go");
  await delay(10);
  stdin.write("\r");
  await waitFor(() => assert.match(lastFrame() ?? "", /执行 browser-use-agent\.click_ref/));
  assert.match(lastFrame() ?? "", /ref: node-42/);
  await delay(100);

  stdin.write("y");
  await waitFor(() => assert.deepEqual(sink.approved, ["a1"]));
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
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, frames, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: undefined,
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
    };
    yield { type: "message-finish", text: "done" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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

test("ChatApp dims reasoning and never shows literal think tags", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  async function* send(): AsyncIterable<SessionEvent> {
    yield { type: "text-delta", delta: "<think>内部思考</think>最终答案" };
    yield { type: "message-finish", text: "<think>内部思考</think>最终答案" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: undefined,
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
  assert.doesNotMatch(frame, /<\/think>/);
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: undefined,
      availableSkills: [TYPE_SKILL],
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
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: undefined,
      availableSkills: [TYPE_SKILL],
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

test("ChatApp sends skill-prefixed prompts as grounded skill instructions", async () => {
  const sink: Sink = { approved: [], rejected: [] };
  const sent: string[] = [];
  const submitted: string[] = [];
  async function* send(input: string): AsyncIterable<SessionEvent> {
    sent.push(input);
    yield { type: "message-finish", text: "" };
  }
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: makeSession(send, sink),
      model: "qwen",
      contextWindow: undefined,
      availableSkills: [TYPE_SKILL],
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
  assert.match(sent[0] ?? "", /roll__skill/);
  assert.match(sent[0] ?? "", /typescript-magician/);
  assert.match(sent[0] ?? "", /修一下类型/);
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
      onUserSubmit: (text: string) => submitted.push(text),
      onExit: () => {
        exited = true;
      },
    }),
  );
  await delay(10);
  for (const ch of "/exit") {
    second.stdin.write(ch);
  }
  await waitFor(() => assert.match(second.lastFrame() ?? "", /\/exit/));
  second.stdin.write("\r");
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
      contextWindow: undefined,
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
