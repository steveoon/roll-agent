import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_OUTCOME_KINDS, type SessionEvent } from "@roll-agent/runtime";
import { chatReducer, createInitialState, type ChatUiState } from "./state.ts";

function event(state: ChatUiState, id: string, e: SessionEvent): ChatUiState {
  return chatReducer(state, { type: "session-event", id, event: e });
}

test("createInitialState seeds model + idle phase", () => {
  const state = createInitialState("qwen", 131072);
  assert.equal(state.phase, "idle");
  assert.equal(state.status.model, "qwen");
  assert.equal(state.status.contextWindow, 131072);
  assert.deepEqual(state.history, []);
});

test("submit-user commits a user bubble and goes busy", () => {
  const state = chatReducer(createInitialState("qwen", undefined), {
    type: "submit-user",
    id: "u1",
    text: "hello",
  });
  assert.equal(state.phase, "busy");
  assert.deepEqual(state.history, [{ kind: "user", id: "u1", text: "hello" }]);
});

test("message-start remains a neutral lifecycle event and text-delta accumulates output", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", { type: "message-start", messageId: "m" });
  assert.equal(state.live.reasoningActive, false);
  state = event(state, "x", { type: "text-delta", delta: "Hel" });
  state = event(state, "x", { type: "text-delta", delta: "lo" });
  assert.equal(state.live.reasoningActive, false);
  assert.equal(state.live.streamingText, "Hello");
});

test("reasoning tokens stream separately and flush before a tool call", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "rs", { type: "reasoning-start", reasoningId: "r1" });
  state = event(state, "rd", {
    type: "reasoning-delta",
    reasoningId: "r1",
    delta: "先定位代码路径",
  });
  assert.equal(state.live.reasoningActive, true);
  assert.equal(state.live.reasoningText, "先定位代码路径");
  assert.equal(state.live.streamingText, "");

  state = event(state, "tc", {
    type: "tool-call",
    toolCallId: "c1",
    agentName: "roll",
    toolName: "search",
    input: { query: "input" },
  });

  assert.deepEqual(state.history, [
    { kind: "reasoning", id: "tc-reasoning", text: "先定位代码路径" },
  ]);
  assert.equal(state.live.reasoningActive, false);
  assert.equal(state.live.reasoningText, "");
  assert.equal(state.live.activeTools[0]?.name, "roll.search");
});

test("reasoning-end commits a dedicated block before the final assistant reply", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "rs", { type: "reasoning-start", reasoningId: "r1" });
  state = event(state, "rd", {
    type: "reasoning-delta",
    reasoningId: "r1",
    delta: "验证边界",
  });
  state = event(state, "re", { type: "reasoning-end", reasoningId: "r1" });
  state = event(state, "td", { type: "text-delta", delta: "结论" });
  state = event(state, "mf", { type: "message-finish", text: "结论" });

  assert.deepEqual(state.history, [
    { kind: "reasoning", id: "re-reasoning", text: "验证边界" },
    { kind: "assistant", id: "mf", text: "结论" },
  ]);
});

test("tool-call adds a live row; tool-result commits it to history", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", {
    type: "tool-call",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    input: { ref: "a" },
  });
  assert.equal(state.live.activeTools.length, 1);
  assert.equal(state.live.activeTools[0]?.name, "browser-use-agent.click_ref");
  state = event(state, "t1", {
    type: "tool-result",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    output: { ok: true },
    isError: false,
  });
  assert.equal(state.live.activeTools.length, 0);
  assert.deepEqual(state.history, [
    { kind: "tool", id: "t1", name: "browser-use-agent.click_ref", args: '{"ref":"a"}', ok: true },
  ]);
});

test("tool-result with denial output commits a denied row instead of a red failure", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", {
    type: "tool-call",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    input: {},
  });
  state = event(state, "d1", {
    type: "tool-result",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    output: { output: "已取消执行: 用户取消", isError: true },
    isError: true,
  });
  assert.equal(state.live.activeTools.length, 0);
  assert.deepEqual(state.history, [
    { kind: "denied", id: "d1", name: "browser-use-agent.click_ref", label: "已取消" },
  ]);
});

test("tool-result with policy denial output commits a denied row", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "d1", {
    type: "tool-result",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    output: "策略拒绝执行: 只读模式",
    isError: true,
  });
  assert.deepEqual(state.history, [
    { kind: "denied", id: "d1", name: "browser-use-agent.click_ref", label: "策略拒绝" },
  ]);
});

test("tool-result uses typed outcome instead of localized display text", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "d1", {
    type: "tool-result",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    outcome: { kind: TOOL_OUTCOME_KINDS.userRejected, reason: "declined" },
    display: "arbitrary localized message",
    output: "arbitrary localized message",
    isError: true,
  });
  assert.deepEqual(state.history, [
    { kind: "denied", id: "d1", name: "browser-use-agent.click_ref", label: "已取消" },
  ]);
});

test("tool-result with ordinary error output keeps the red failure row", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "t1", {
    type: "tool-result",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    output: { output: "element not found", isError: true },
    isError: true,
  });
  assert.deepEqual(state.history, [
    { kind: "tool", id: "t1", name: "browser-use-agent.click_ref", args: "", ok: false },
  ]);
});

test("turn-cancelled marks active tools as interrupted and records the reason", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", {
    type: "tool-call",
    toolCallId: "c1",
    agentName: "roll",
    toolName: "powershell",
    input: { command: "Start-Sleep -Seconds 30" },
  });
  state = event(state, "cancel-1", {
    type: "turn-cancelled",
    reason: "user",
    message: "已取消本轮；工具已收到中断请求。",
  });

  assert.equal(state.live.activeTools.length, 0);
  assert.deepEqual(state.history, [
    {
      kind: "cancelled",
      id: "cancel-1-tool-0",
      name: "roll.powershell",
      args: '{"command":"Start-Sleep -Seconds 30"}',
    },
    {
      kind: "turn-cancelled",
      id: "cancel-1",
      text: "已取消本轮；工具已收到中断请求。",
      reason: "user",
    },
  ]);
});

test("Ink reducer 保留 batch success/tool_failed/cancelled 的类型化事件语义", () => {
  let state = createInitialState("qwen", undefined);
  for (const [toolCallId, toolName] of [
    ["batch-ok", "read_ok"],
    ["batch-fail", "read_fail"],
    ["batch-running", "wait"],
  ] as const) {
    state = event(state, `call-${toolCallId}`, {
      type: "tool-call",
      toolCallId,
      agentName: "batch-agent",
      toolName,
      input: {},
    });
  }
  state = event(state, "result-ok", {
    type: "tool-result",
    toolCallId: "batch-ok",
    agentName: "batch-agent",
    toolName: "read_ok",
    outcome: { kind: TOOL_OUTCOME_KINDS.success },
    display: "ok",
    output: "ok",
    isError: false,
  });
  state = event(state, "result-fail", {
    type: "tool-result",
    toolCallId: "batch-fail",
    agentName: "batch-agent",
    toolName: "read_fail",
    outcome: { kind: TOOL_OUTCOME_KINDS.toolFailed, reason: "boom" },
    display: "boom",
    output: "boom",
    isError: true,
  });
  state = event(state, "batch-cancel", {
    type: "turn-cancelled",
    reason: "user",
    message: "已取消本轮。",
  });

  assert.equal(state.live.activeTools.length, 0);
  assert.deepEqual(state.history, [
    { kind: "tool", id: "result-ok", name: "batch-agent.read_ok", args: "{}", ok: true },
    {
      kind: "tool",
      id: "result-fail",
      name: "batch-agent.read_fail",
      args: "{}",
      ok: false,
    },
    {
      kind: "cancelled",
      id: "batch-cancel-tool-0",
      name: "batch-agent.wait",
      args: "{}",
    },
    {
      kind: "turn-cancelled",
      id: "batch-cancel",
      text: "已取消本轮。",
      reason: "user",
    },
  ]);
});

test("think tag spanning a tool call carries into the next segment", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", { type: "text-delta", delta: "先看页面<think>用户想登录" });
  state = event(state, "n1", {
    type: "tool-call",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "browser_snapshot",
    input: {},
  });
  assert.equal(state.live.thinkTagOpen, true);
  state = event(state, "t1", {
    type: "tool-result",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "browser_snapshot",
    output: "ok",
    isError: false,
  });
  state = event(state, "x", { type: "text-delta", delta: "快照拿到了</think>页面已打开" });
  state = event(state, "m1", {
    type: "message-finish",
    text: "页面已打开",
  });
  const assistants = state.history.filter((item) => item.kind === "assistant");
  assert.deepEqual(assistants, [
    { kind: "assistant", id: "n1", text: "先看页面<think>用户想登录" },
    { kind: "assistant", id: "m1", text: "<think>快照拿到了</think>页面已打开" },
  ]);
  assert.equal(state.live.thinkTagOpen, false);
});

test("narration commits ahead of the tool it triggers (correct order)", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", { type: "text-delta", delta: "我来点击按钮" });
  state = event(state, "tc", {
    type: "tool-call",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    input: {},
  });
  state = event(state, "tr", {
    type: "tool-result",
    toolCallId: "c1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    output: {},
    isError: false,
  });
  assert.equal(state.history.length, 2);
  assert.deepEqual(state.history[0], { kind: "assistant", id: "tc", text: "我来点击按钮" });
  assert.equal(state.history[1]?.kind, "tool");
  assert.equal(state.live.streamingText, "");
});

test("message-finish with stoppedAtStepLimit appends a step-limit notice", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", { type: "text-delta", delta: "做了一半" });
  state = event(state, "f1", {
    type: "message-finish",
    text: "做了一半",
    stoppedAtStepLimit: true,
  });
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0]?.kind, "assistant");
  const notice = state.history[1];
  assert.equal(notice?.kind, "notice");
  assert.match(notice?.kind === "notice" ? notice.text : "", /最大工具步数/);
});

test("confirmation-required enters confirm phase; confirm-resolved returns to busy", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", {
    type: "confirmation-required",
    approvalId: "a1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    input: {},
    reason: "高风险",
    explanation: "  点击目标按钮，\n\t继续完成当前任务\u0000  ",
  });
  assert.equal(state.phase, "confirm");
  assert.deepEqual(state.pendingConfirm, {
    approvalId: "a1",
    prompt: "执行 browser-use-agent.click_ref（高风险）?",
    args: "",
    explanation: "点击目标按钮， 继续完成当前任务",
  });
  state = chatReducer(state, { type: "confirm-resolved" });
  assert.equal(state.phase, "busy");
  assert.equal(state.pendingConfirm, undefined);
});

test("confirmation-required remains compatible when explanation is absent", () => {
  const state = event(createInitialState("qwen", undefined), "x", {
    type: "confirmation-required",
    approvalId: "legacy-a1",
    agentName: "browser-use-agent",
    toolName: "click_ref",
    input: { ref: "node-42" },
  });

  assert.deepEqual(state.pendingConfirm, {
    approvalId: "legacy-a1",
    prompt: "执行 browser-use-agent.click_ref?",
    args: "ref: node-42",
  });
});

test("compaction events toggle spinner and commit a notice", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", { type: "compaction-start", reason: "auto" });
  assert.equal(state.live.compacting, true);
  state = event(state, "k1", {
    type: "context-compacted",
    reason: "auto",
    strategy: "summarize",
    removed: 58,
    kept: 14,
    truncatedTools: 3,
    checkpointId: "8ba32466-1cb6-4166-a496-fdd8ff048891",
    checkpointGeneration: 2,
    checkpointSummaryStatus: "fallback",
  });
  assert.equal(state.live.compacting, false);
  const notice = state.history.at(-1);
  assert.match(
    notice?.kind === "compaction" ? notice.notice : "",
    /移除 58 条 → 保留 14 条，精简 3 个工具结果，checkpoint #2\(fallback\)/,
  );
});

test("message-finish commits streamed assistant text and updates status", () => {
  let state = createInitialState("qwen", 200000);
  state = event(state, "x", { type: "text-delta", delta: "答案" });
  state = event(state, "a1", {
    type: "message-finish",
    text: "答案",
    totalUsage: { inputTokens: 100, outputTokens: 20 },
    sessionUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    contextInputTokens: 100,
  });
  assert.deepEqual(state.history, [{ kind: "assistant", id: "a1", text: "答案" }]);
  assert.equal(state.live.streamingText, "");
  assert.equal(state.status.contextInputTokens, 100);
  assert.equal(state.status.sessionUsage?.totalTokens, 120);
});

test("message-finish with empty text but output tokens commits a notice", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "n1", {
    type: "message-finish",
    text: "",
    totalUsage: { outputTokens: 12 },
  });
  assert.equal(state.history.at(-1)?.kind, "notice");
});

test("error commits an error row and clears the live region", () => {
  let state = createInitialState("qwen", undefined);
  state = event(state, "x", { type: "text-delta", delta: "partial" });
  state = event(state, "e1", { type: "error", stage: "execute", message: "boom" });
  assert.deepEqual(state.history.at(-1), { kind: "error", id: "e1", message: "boom" });
  assert.equal(state.live.streamingText, "");
});

test("turn-end returns to idle", () => {
  let state = chatReducer(createInitialState("qwen", undefined), {
    type: "submit-user",
    id: "u1",
    text: "hi",
  });
  state = chatReducer(state, { type: "turn-end" });
  assert.equal(state.phase, "idle");
});

test("cancel-requested exposes the pending cancellation phase", () => {
  let state = chatReducer(createInitialState("qwen", undefined), {
    type: "submit-user",
    id: "u1",
    text: "hi",
  });
  state = chatReducer(state, { type: "cancel-requested" });
  assert.equal(state.phase, "cancelling");
});

test("createInitialState seeds provided history and thinking level", () => {
  const state = createInitialState("qwen", 200000, {
    history: [{ kind: "user", id: "h-0", text: "hi" }],
    thinkingLevel: "high",
  });
  assert.equal(state.history.length, 1);
  assert.equal(state.status.thinkingLevel, "high");
  assert.equal(state.draft, "");
});

test("createInitialState defaults thinking level to medium and empty draft", () => {
  const state = createInitialState("qwen", undefined);
  assert.equal(state.status.thinkingLevel, "medium");
  assert.equal(state.draft, "");
});

test("set-draft / set-thinking / commit-history actions", () => {
  let state = createInitialState("qwen", undefined);
  state = chatReducer(state, { type: "set-draft", value: "/th" });
  assert.equal(state.draft, "/th");
  state = chatReducer(state, { type: "set-thinking", level: "off" });
  assert.equal(state.status.thinkingLevel, "off");
  state = chatReducer(state, {
    type: "commit-history",
    item: { kind: "notice", id: "n1", text: "hi" },
  });
  assert.equal(state.history.at(-1)?.kind, "notice");
  assert.equal(state.draft, "");
});

test("set-auto toggles status.autoApprove without touching confirm state", () => {
  let state = createInitialState("qwen", undefined);
  assert.equal(state.status.autoApprove, false);
  state = chatReducer(state, { type: "set-auto", value: true });
  assert.equal(state.status.autoApprove, true);
  assert.equal(state.phase, "idle");
  assert.equal(state.pendingConfirm, undefined);
  state = chatReducer(state, { type: "set-auto", value: false });
  assert.equal(state.status.autoApprove, false);
});

test("user input has an independent phase and only the matching request can clear it", () => {
  type PendingUserInput = Extract<SessionEvent, { readonly type: "user-input-required" }>;
  const requestId = "00000000-0000-4000-8000-000000000185" as PendingUserInput["requestId"];
  const otherRequestId = "00000000-0000-4000-8000-000000000186" as PendingUserInput["requestId"];
  let state = event(createInitialState("qwen", undefined), "input", {
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
    expiresAt: "2099-01-01T00:00:00.000Z",
  });

  assert.equal(state.phase, "user-input");
  assert.equal(state.pendingUserInput?.requestId, requestId);
  assert.equal(state.pendingConfirm, undefined);

  state = event(state, "other", {
    type: "user-input-settled",
    requestId: otherRequestId,
    status: "cancelled",
  });
  assert.equal(state.phase, "user-input");

  state = chatReducer(state, { type: "user-input-resolved", requestId });
  assert.equal(state.phase, "busy");
  assert.equal(state.pendingUserInput, undefined);
});
