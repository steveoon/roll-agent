import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, createInitialState } from "./state.ts";
import { resolveTurnActivity } from "./turn-activity.ts";
import type { SessionEvent } from "@roll-agent/runtime";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { HistoryItemView } from "./history-item.ts";

test("model recovery rolls back only the unfinished step, including already rendered reasoning", () => {
  let state = chatReducer(createInitialState("fixture", undefined), {
    type: "submit-user",
    id: "user",
    text: "task",
  });
  let id = 0;
  const emit = (event: SessionEvent) => {
    state = chatReducer(state, { type: "session-event", event, at: 100, id: String(id++) });
  };
  emit({ type: "model-step-start" });
  emit({ type: "text-delta", delta: "completed explanation" });
  emit({
    type: "tool-call",
    toolCallId: "tool",
    agentName: "fixture",
    toolName: "write",
    input: {},
  });
  emit({
    type: "tool-result",
    toolCallId: "tool",
    agentName: "fixture",
    toolName: "write",
    output: "ok",
    display: "ok",
    outcome: { kind: "success" },
    isError: false,
  });
  emit({ type: "step-finish", finishReason: "tool-calls" });
  emit({ type: "model-step-start" });
  emit({ type: "reasoning-start", reasoningId: "r" });
  emit({ type: "reasoning-delta", reasoningId: "r", delta: "unfinished reasoning" });
  emit({ type: "reasoning-end", reasoningId: "r" });
  emit({ type: "text-delta", delta: "unfinished text" });
  emit({ type: "model-recovery", attempt: 1 });
  assert.equal(state.phase, "busy");
  assert.equal(state.live.streamingText, "");
  assert.doesNotMatch(JSON.stringify(state.history), /unfinished/);
  assert.match(JSON.stringify(state.history), /completed explanation/);
  assert.equal(state.history.filter((item) => item.kind === "tool").length, 1);
  assert.equal(state.history.filter((item) => item.kind === "user").length, 1);
  assert.equal(resolveTurnActivity(state)?.label, "恢复连接中…");
  emit({ type: "model-step-start" });
  assert.equal(resolveTurnActivity(state)?.label, "等待模型响应…");
  state = chatReducer(state, { type: "cancel-requested" });
  emit({ type: "model-recovery", attempt: 2 });
  assert.equal(resolveTurnActivity(state)?.label, "正在中断…");
  state = chatReducer(state, { type: "turn-end" });
  emit({ type: "model-recovery", attempt: 3 });
  assert.equal(state.phase, "idle");
});

test("terminal failure discards the last provisional reasoning without deleting completed output", () => {
  let state = chatReducer(createInitialState("fixture", undefined), {
    type: "submit-user",
    id: "u",
    text: "task",
  });
  let id = 0;
  const emit = (event: SessionEvent) => {
    state = chatReducer(state, { type: "session-event", event, at: 1, id: String(id++) });
  };
  emit({ type: "model-step-start" });
  emit({ type: "text-delta", delta: "completed" });
  emit({ type: "step-finish", finishReason: "tool-calls" });
  emit({ type: "model-step-start" });
  emit({ type: "reasoning-start", reasoningId: "r" });
  emit({ type: "reasoning-delta", reasoningId: "r", delta: "unfinished" });
  emit({ type: "reasoning-end", reasoningId: "r" });
  emit({ type: "error", stage: "execute", message: "stopped" });
  assert.doesNotMatch(JSON.stringify(state.history), /unfinished/);
  assert.match(JSON.stringify(state.history), /completed/);
  assert.equal(state.history.filter((item) => item.kind === "error").length, 1);
});

test("cancelled tool results survive recovery and distinguish unexecuted from uncertain work", () => {
  for (const executionState of ["not_executed", "outcome_unknown"] as const) {
    let state = chatReducer(createInitialState("fixture", undefined), {
      type: "submit-user",
      id: "u",
      text: "task",
    });
    let id = 0;
    const emit = (event: SessionEvent) => {
      state = chatReducer(state, { type: "session-event", event, at: 1, id: String(id++) });
    };
    emit({ type: "model-step-start" });
    emit({
      type: "tool-call",
      toolCallId: "c",
      agentName: "fixture",
      toolName: "write",
      input: { path: "a.ts" },
    });
    emit({
      type: "tool-result",
      toolCallId: "c",
      agentName: "fixture",
      toolName: "write",
      outcome: { kind: "cancelled", reason: "runtime", executionState },
      display: "cancelled",
      output: "cancelled",
      isError: true,
    });
    emit(
      executionState === "not_executed"
        ? { type: "model-recovery", attempt: 1 }
        : { type: "error", stage: "execute", message: "stopped" },
    );
    assert.equal(state.live.activeTools.length, 0);
    const item = state.history.find((entry) => entry.kind === "cancelled");
    assert.ok(item);
    assert.equal(state.history.filter((entry) => entry.kind === "cancelled").length, 1);
    const { lastFrame, unmount } = render(h(HistoryItemView, { item }));
    try {
      assert.match(lastFrame() ?? "", /fixture\.write/);
      assert.match(lastFrame() ?? "", /a\.ts/);
      assert.match(lastFrame() ?? "", executionState === "not_executed" ? /未执行/ : /结果待确认/);
      assert.doesNotMatch(lastFrame() ?? "", /[✓✗]/);
    } finally {
      unmount();
    }
  }
});

test("terminal errors retain unsettled tools when no durable result could be emitted", () => {
  let state = chatReducer(createInitialState("fixture", undefined), {
    type: "submit-user",
    id: "u",
    text: "task",
  });
  state = chatReducer(state, {
    type: "session-event",
    at: 1,
    id: "call",
    event: {
      type: "tool-call",
      toolCallId: "c",
      agentName: "fixture",
      toolName: "write",
      input: {},
    },
  });
  state = chatReducer(state, {
    type: "session-event",
    at: 2,
    id: "error",
    event: {
      type: "error",
      stage: "execute",
      message: "tool ledger unavailable",
    },
  });
  assert.equal(state.live.activeTools.length, 0);
  const item = state.history.find((entry) => entry.kind === "cancelled");
  assert.ok(item);
  const { lastFrame, unmount } = render(h(HistoryItemView, { item }));
  try {
    assert.match(lastFrame() ?? "", /结果待确认/);
    assert.doesNotMatch(lastFrame() ?? "", /未执行/);
  } finally {
    unmount();
  }
});
