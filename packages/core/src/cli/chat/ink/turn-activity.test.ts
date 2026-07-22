import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@roll-agent/runtime";
import { chatReducer, createInitialState, type ChatUiState } from "./state.ts";
import { resolveTurnActivity, TURN_ACTIVITY_KINDS } from "./turn-activity.ts";

function busyState(): ChatUiState {
  return chatReducer(createInitialState("qwen", undefined), {
    type: "submit-user",
    id: "u1",
    text: "hello",
  });
}

function event(state: ChatUiState, value: SessionEvent): ChatUiState {
  return chatReducer(state, { type: "session-event", id: "event", event: value });
}

test("resolveTurnActivity distinguishes waiting, reasoning, reply, and tool phases", () => {
  let state = busyState();
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.waitingModel);

  state = event(state, { type: "reasoning-start", reasoningId: "r1" });
  state = event(state, { type: "reasoning-delta", reasoningId: "r1", delta: "分析中" });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.reasoning);

  state = event(state, { type: "reasoning-end", reasoningId: "r1" });
  state = event(state, { type: "text-delta", delta: "正在回答" });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.replying);

  state = event(state, {
    type: "tool-call",
    toolCallId: "c1",
    agentName: "roll",
    toolName: "search",
    input: {},
  });
  const toolActivity = resolveTurnActivity(state);
  assert.equal(toolActivity?.kind, TURN_ACTIVITY_KINDS.tool);
  assert.match(toolActivity?.label ?? "", /roll\.search/);
});

test("resolveTurnActivity keeps legacy inline think tags semantic", () => {
  let state = busyState();
  state = event(state, { type: "text-delta", delta: "<think>兼容旧模型" });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.reasoning);
});

test("resolveTurnActivity prioritizes confirmation and cancellation", () => {
  let state = busyState();
  state = event(state, {
    type: "confirmation-required",
    approvalId: "a1",
    agentName: "browser",
    toolName: "click",
    input: {},
  });
  const confirmation = resolveTurnActivity(state);
  assert.equal(confirmation?.kind, TURN_ACTIVITY_KINDS.waitingUser);
  assert.equal(confirmation?.animated, false);

  state = chatReducer(state, { type: "cancel-requested" });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.cancelling);
});

test("manual compaction reports compacting immediately", () => {
  const state = chatReducer(createInitialState("qwen", undefined), {
    type: "start-compaction",
  });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.compacting);
});
