import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { ChatApp } from "./app.ts";

interface Sink {
  approved: string[];
  rejected: string[];
}

function makeSession(
  send: (input: string) => AsyncIterable<SessionEvent>,
  sink: Sink,
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
    abort() {},
  } as unknown as AgentSession;
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

test("ChatApp confirm flow approves on y and resumes the turn", async () => {
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

  stdin.write("y");
  await waitFor(() => assert.deepEqual(sink.approved, ["a1"]));
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
  assert.match(lastFrame() ?? "", /🧠 medium/);
  stdin.write("\x1b[46;3u");
  await delay(20);
  assert.match(lastFrame() ?? "", /🧠 high/);
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
