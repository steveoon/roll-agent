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
  await delay(40);
  assert.match(lastFrame() ?? "", /执行 browser-use-agent\.click_ref/);

  stdin.write("y");
  await delay(40);
  assert.deepEqual(sink.approved, ["a1"]);
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

test("ChatApp commits many tool rows to scrollback history", async () => {
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
