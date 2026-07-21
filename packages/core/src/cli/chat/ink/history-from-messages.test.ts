import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { createTurnCancellationMessage, SUMMARY_ACK, SUMMARY_PREFIX } from "@roll-agent/runtime";
import { messagesToHistory } from "./history-from-messages.ts";

test("messagesToHistory returns [] for empty input", () => {
  assert.deepEqual(messagesToHistory([]), []);
});

test("messagesToHistory maps user/assistant/tool with ok/error pairing", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "帮我点一下" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "好的,我来点击:" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "browser-use-agent__click_ref",
          input: { ref: "@e2" },
        },
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "browser-use-agent__browser_snapshot",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "browser-use-agent__click_ref",
          output: { type: "text", value: "ok" },
        },
        {
          type: "tool-result",
          toolCallId: "c2",
          toolName: "browser-use-agent__browser_snapshot",
          output: { type: "error-text", value: "boom" },
        },
      ],
    },
  ];
  const history = messagesToHistory(messages);
  assert.deepEqual(history, [
    { kind: "user", id: "h-0", text: "帮我点一下" },
    { kind: "assistant", id: "h-1", text: "好的,我来点击:" },
    {
      kind: "tool",
      id: "h-1-1",
      name: "browser-use-agent.click_ref",
      args: '{"ref":"@e2"}',
      ok: true,
    },
    {
      kind: "tool",
      id: "h-1-2",
      name: "browser-use-agent.browser_snapshot",
      args: "{}",
      ok: false,
    },
  ]);
});

test("messagesToHistory renders compaction summary as a notice and skips the ack", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: `${SUMMARY_PREFIX}\n\n之前做了 X` },
    { role: "assistant", content: SUMMARY_ACK },
    { role: "user", content: "继续" },
  ];
  const history = messagesToHistory(messages);
  assert.equal(history.length, 2);
  assert.equal(history[0]?.kind, "compaction");
  assert.deepEqual(history[1], { kind: "user", id: "h-2", text: "继续" });
});

test("messagesToHistory defaults tool ok=true when no result is present", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "x", toolName: "agent__act", input: {} }],
    },
  ];
  const history = messagesToHistory(messages);
  assert.deepEqual(history, [
    { kind: "tool", id: "h-0-0", name: "agent.act", args: "{}", ok: true },
  ]);
});

test("messagesToHistory ignores assistant reasoning parts (no raw reasoning in UI)", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "内部推理不应显示" },
        { type: "text", text: "可见回复" },
      ],
    },
  ];
  const history = messagesToHistory(messages);
  assert.deepEqual(history, [{ kind: "assistant", id: "h-0", text: "可见回复" }]);
});

test("messagesToHistory 恢复取消原因与专用展示语义", () => {
  const message = createTurnCancellationMessage("本轮等待时间过长，已自动停止。", "timeout");

  assert.deepEqual(messagesToHistory([message]), [
    {
      kind: "turn-cancelled",
      id: "h-0",
      text: "本轮等待时间过长，已自动停止。",
      reason: "timeout",
    },
  ]);
});
