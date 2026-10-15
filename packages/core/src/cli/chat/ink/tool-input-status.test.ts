import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@roll-agent/runtime";
import { chatReducer, createInitialState, type ChatUiState } from "./state.ts";
import { resolveTurnActivity, TURN_ACTIVITY_KINDS } from "./turn-activity.ts";

function event(state: ChatUiState, value: SessionEvent) {
  return chatReducer(state, { type: "session-event", id: "evt", at: 0, event: value });
}
function generating() {
  return event(
    chatReducer(createInitialState("fixture", undefined), {
      type: "submit-user",
      id: "u",
      text: "write",
    }),
    {
      type: "tool-input-activity",
      calls: [
        { toolCallId: "a", name: "roll.write_file" },
        { toolCallId: "b", name: "roll.edit_file" },
      ],
    },
  );
}

test("parameter metadata is temporary, names are safe, call IDs interleave independently", () => {
  let state = generating();
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.toolInput);
  assert.match(
    resolveTurnActivity(state)?.label ?? "",
    /正在生成工具参数 roll\.write_file 等 2 项/,
  );
  assert.deepEqual(state.live.activeTools, []);
  assert.equal(state.pendingConfirm, undefined);
  assert.equal(state.history.length, 1, "generation is not a history or completed-work entry");
  state = event(state, {
    type: "tool-input-activity",
    calls: [{ toolCallId: "b", name: "roll.edit_file" }],
  });
  assert.match(resolveTurnActivity(state)?.label ?? "", /roll\.edit_file/);
  state = event(state, { type: "tool-input-activity", calls: [] });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.waitingModel);
  state = event(state, {
    type: "tool-input-activity",
    calls: [{ toolCallId: "x", name: "\u001b[31mSECRET\n" }],
  });
  assert.equal(resolveTurnActivity(state)?.label, "正在生成工具参数…");
  assert.doesNotMatch(resolveTurnActivity(state)?.label ?? "", /SECRET/);
});

test("execution, compaction, confirmation and cancellation have priority over argument generation", () => {
  let state = event(generating(), {
    type: "tool-call",
    toolCallId: "a",
    agentName: "roll",
    toolName: "write_file",
    input: {},
  });
  assert.deepEqual(
    state.live.generatingTools.map((call) => call.toolCallId),
    ["b"],
  );
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.tool);
  state = event(state, { type: "compaction-start", reason: "auto" });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.compacting);
  assert.deepEqual(state.live.generatingTools, []);
  state = event(state, {
    type: "confirmation-required",
    approvalId: "approval",
    agentName: "roll",
    toolName: "write_file",
    input: {},
  });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.waitingUser);
  state = chatReducer(state, { type: "cancel-requested" });
  state = event(state, {
    type: "tool-input-activity",
    calls: [{ toolCallId: "late", name: "roll.write_file" }],
  });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.cancelling);
  assert.deepEqual(state.live.generatingTools, []);
});

for (const terminal of [
  { type: "step-finish", finishReason: "stop" },
  { type: "message-finish", text: "done" },
  { type: "error", stage: "execute", message: "failed" },
  { type: "turn-cancelled", reason: "user", message: "cancelled" },
] as const) {
  test(`${terminal.type} clears orphaned generation without creating Tool completion`, () => {
    const state = event(generating(), terminal);
    assert.deepEqual(state.live.generatingTools, []);
    assert.equal(state.history.filter((item) => item.kind === "tool").length, 0);
    const idle = chatReducer(state, { type: "turn-end" });
    assert.equal(resolveTurnActivity(idle), undefined);
    assert.equal(
      event(idle, { type: "tool-input-activity", calls: [{ toolCallId: "late" }] }),
      idle,
    );
  });
}

test("provider without observable argument stream stays waiting until complete Tool call", () => {
  const state = chatReducer(createInitialState("fixture", undefined), {
    type: "submit-user",
    id: "u",
    text: "work",
  });
  assert.equal(resolveTurnActivity(state)?.kind, TURN_ACTIVITY_KINDS.waitingModel);
  const complete = event(state, {
    type: "tool-call",
    toolCallId: "a",
    agentName: "roll",
    toolName: "write_file",
    input: {},
  });
  assert.equal(resolveTurnActivity(complete)?.kind, TURN_ACTIVITY_KINDS.tool);
});
