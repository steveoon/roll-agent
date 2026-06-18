import type { SessionEvent, SessionTokenUsage } from "@roll-agent/runtime";
import { formatToolInput } from "../../utils/tool-format.ts";

export interface ToolRowState {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: string;
}

export type HistoryItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly args: string;
      readonly ok: boolean;
    }
  | { readonly kind: "compaction"; readonly id: string; readonly notice: string }
  | { readonly kind: "notice"; readonly id: string; readonly text: string }
  | { readonly kind: "error"; readonly id: string; readonly message: string };

export interface LiveState {
  readonly streamingText: string;
  readonly thinking: boolean;
  readonly activeTools: readonly ToolRowState[];
  readonly compacting: boolean;
  readonly producedOutput: boolean;
}

export interface StatusState {
  readonly model: string;
  readonly contextWindow: number | undefined;
  readonly turnUsage: SessionTokenUsage | undefined;
  readonly sessionUsage: SessionTokenUsage | undefined;
  readonly contextInputTokens: number | undefined;
}

export type ChatPhase = "idle" | "busy" | "confirm";

export interface PendingConfirm {
  readonly approvalId: string;
  readonly prompt: string;
}

export interface ChatUiState {
  readonly history: readonly HistoryItem[];
  readonly live: LiveState;
  readonly status: StatusState;
  readonly phase: ChatPhase;
  readonly pendingConfirm: PendingConfirm | undefined;
}

export type ChatUiAction =
  | { readonly type: "submit-user"; readonly id: string; readonly text: string }
  | { readonly type: "start-compaction" }
  | { readonly type: "session-event"; readonly id: string; readonly event: SessionEvent }
  | { readonly type: "confirm-resolved" }
  | { readonly type: "turn-end" };

const EMPTY_LIVE: LiveState = {
  streamingText: "",
  thinking: false,
  activeTools: [],
  compacting: false,
  producedOutput: false,
};

export function createInitialState(model: string, contextWindow: number | undefined): ChatUiState {
  return {
    history: [],
    live: EMPTY_LIVE,
    status: {
      model,
      contextWindow,
      turnUsage: undefined,
      sessionUsage: undefined,
      contextInputTokens: undefined,
    },
    phase: "idle",
    pendingConfirm: undefined,
  };
}

export function buildConfirmPrompt(
  event: Extract<SessionEvent, { type: "confirmation-required" }>,
): string {
  const reason = event.reason ? `（${event.reason}）` : "";
  return `执行 ${event.agentName}.${event.toolName}${reason}?`;
}

function buildCompactionNotice(
  event: Extract<SessionEvent, { type: "context-compacted" }>,
): string {
  const label = event.reason === "auto" ? "自动压缩" : "手动压缩";
  const tools = event.truncatedTools ? `，精简 ${String(event.truncatedTools)} 个工具结果` : "";
  if (event.removed === 0 && !event.truncatedTools) {
    return `🗜 ${label}：无需压缩`;
  }
  return `🗜 ${label}(${event.strategy})：移除 ${String(event.removed)} 条 → 保留 ${String(event.kept)} 条${tools}`;
}

function commitTool(
  state: ChatUiState,
  id: string,
  event: Extract<SessionEvent, { type: "tool-result" }>,
): ChatUiState {
  const active = state.live.activeTools.find((tool) => tool.toolCallId === event.toolCallId);
  const name = active?.name ?? `${event.agentName}.${event.toolName}`;
  const args = active?.args ?? "";
  return {
    ...state,
    history: [...state.history, { kind: "tool", id, name, args, ok: !event.isError }],
    live: {
      ...state.live,
      activeTools: state.live.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId),
    },
  };
}

function applySessionEvent(state: ChatUiState, id: string, event: SessionEvent): ChatUiState {
  switch (event.type) {
    case "message-start":
      return { ...state, live: { ...state.live, thinking: true } };
    case "text-delta":
      return {
        ...state,
        live: {
          ...state.live,
          thinking: false,
          producedOutput: true,
          streamingText: state.live.streamingText + event.delta,
        },
      };
    case "tool-call": {
      const narration: HistoryItem[] =
        state.live.streamingText.length > 0
          ? [{ kind: "assistant", id, text: state.live.streamingText }]
          : [];
      return {
        ...state,
        history: [...state.history, ...narration],
        live: {
          ...state.live,
          thinking: false,
          producedOutput: true,
          streamingText: "",
          activeTools: [
            ...state.live.activeTools,
            {
              toolCallId: event.toolCallId,
              name: `${event.agentName}.${event.toolName}`,
              args: formatToolInput(event.input),
            },
          ],
        },
      };
    }
    case "tool-result":
      return commitTool(state, id, event);
    case "confirmation-required":
      return {
        ...state,
        phase: "confirm",
        pendingConfirm: { approvalId: event.approvalId, prompt: buildConfirmPrompt(event) },
      };
    case "compaction-start":
      return { ...state, live: { ...state.live, compacting: true } };
    case "context-compacted":
      return {
        ...state,
        live: { ...state.live, compacting: false },
        history: [
          ...state.history,
          { kind: "compaction", id, notice: buildCompactionNotice(event) },
        ],
      };
    case "message-finish": {
      const committed: HistoryItem[] = [];
      if (state.live.streamingText.length > 0) {
        committed.push({ kind: "assistant", id, text: state.live.streamingText });
      } else if (!state.live.producedOutput && (event.totalUsage?.outputTokens ?? 0) > 0) {
        committed.push({
          kind: "notice",
          id,
          text: "模型本轮只返回了 thinking/reasoning，没有生成可见回复",
        });
      }
      if (event.stoppedAtStepLimit) {
        committed.push({
          kind: "notice",
          id: `${id}-step-limit`,
          text: "已达单轮最大工具步数，任务可能未完成 — 继续追问即可接着做，或调高 runtime.max-steps",
        });
      }
      return {
        ...state,
        history: [...state.history, ...committed],
        live: { ...EMPTY_LIVE },
        status: {
          ...state.status,
          turnUsage: event.totalUsage,
          sessionUsage: event.sessionUsage,
          contextInputTokens: event.contextInputTokens,
        },
      };
    }
    case "error":
      return {
        ...state,
        history: [...state.history, { kind: "error", id, message: event.message }],
        live: { ...EMPTY_LIVE },
      };
    default:
      return state;
  }
}

export function chatReducer(state: ChatUiState, action: ChatUiAction): ChatUiState {
  switch (action.type) {
    case "submit-user":
      return {
        ...state,
        history: [...state.history, { kind: "user", id: action.id, text: action.text }],
        live: { ...EMPTY_LIVE },
        phase: "busy",
        pendingConfirm: undefined,
      };
    case "start-compaction":
      return { ...state, live: { ...EMPTY_LIVE }, phase: "busy", pendingConfirm: undefined };
    case "session-event":
      return applySessionEvent(state, action.id, action.event);
    case "confirm-resolved":
      return { ...state, phase: "busy", pendingConfirm: undefined };
    case "turn-end":
      return { ...state, phase: "idle", live: { ...EMPTY_LIVE } };
    default:
      return state;
  }
}
