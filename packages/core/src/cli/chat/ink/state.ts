import { TOOL_OUTCOME_KINDS, type SessionEvent, type SessionTokenUsage } from "@roll-agent/runtime";
import {
  formatApprovalDetails,
  formatApprovalExplanation,
  formatToolInput,
} from "../../utils/tool-format.ts";
import { GLYPHS } from "../../utils/glyphs.ts";
import { endsInsideThink } from "./thinking-text.ts";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import type { ChatThinkingDisplay } from "../../../config/schema.ts";
import type { BannerLine } from "../banner.ts";

export interface ToolRowState {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: string;
  readonly outputTail?: string;
}

type TurnCancelledReason = Extract<SessionEvent, { type: "turn-cancelled" }>["reason"];

const MAX_TOOL_OUTPUT_TAIL_CHARS = 2_000;

export type HistoryItem =
  | { readonly kind: "banner"; readonly id: string; readonly lines: readonly BannerLine[] }
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly attachmentLabels?: readonly string[];
    }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly text: string;
      /** 思考从开始到落盘的墙钟时长，供折叠摘要展示。 */
      readonly durationMs?: number;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly args: string;
      readonly ok: boolean;
    }
  | {
      readonly kind: "denied";
      readonly id: string;
      readonly name: string;
      readonly label: string;
    }
  | {
      readonly kind: "cancelled";
      readonly id: string;
      readonly name: string;
      readonly args: string;
    }
  | { readonly kind: "compaction"; readonly id: string; readonly notice: string }
  | {
      readonly kind: "turn-cancelled";
      readonly id: string;
      readonly text: string;
      readonly reason: TurnCancelledReason;
    }
  | { readonly kind: "notice"; readonly id: string; readonly text: string }
  | { readonly kind: "error"; readonly id: string; readonly message: string };

export interface LiveState {
  readonly streamingText: string;
  readonly reasoningId: string | undefined;
  readonly reasoningText: string;
  readonly reasoningActive: boolean;
  /** 当前 reasoning 段开始时的墙钟时间戳，用于计算折叠摘要中的思考时长。 */
  readonly reasoningStartedAt: number | undefined;
  readonly thinkTagOpen: boolean;
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
  readonly outputTokensPerSecond: number | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly autoApprove: boolean;
}

export const CHAT_PHASES = {
  idle: "idle",
  busy: "busy",
  confirm: "confirm",
  userInput: "user-input",
  cancelling: "cancelling",
} as const;

export type ChatPhase = (typeof CHAT_PHASES)[keyof typeof CHAT_PHASES];

export interface PendingConfirm {
  readonly approvalId: string;
  readonly prompt: string;
  readonly args: string;
  readonly explanation?: string;
  readonly sessionGrantLabel?: string;
}

export interface ConfirmDecision {
  readonly approved: boolean;
  readonly scope?: "session";
}

export type PendingUserInput = Extract<SessionEvent, { readonly type: "user-input-required" }>;

export interface ChatUiState {
  readonly history: readonly HistoryItem[];
  readonly draft: string;
  readonly live: LiveState;
  readonly status: StatusState;
  readonly phase: ChatPhase;
  readonly pendingConfirm: PendingConfirm | undefined;
  readonly pendingUserInput: PendingUserInput | undefined;
  /** 已完成思考内容的展示方式；仅影响已落盘 history 的渲染，不影响思考中的实时展示。 */
  readonly thinkingDisplay: ChatThinkingDisplay;
}

export type ChatUiAction =
  | {
      readonly type: "submit-user";
      readonly id: string;
      readonly text: string;
      readonly attachmentLabels?: readonly string[];
    }
  | { readonly type: "set-draft"; readonly value: string }
  | { readonly type: "set-thinking"; readonly level: ThinkingLevel }
  | { readonly type: "set-thinking-display"; readonly value: ChatThinkingDisplay }
  | { readonly type: "set-auto"; readonly value: boolean }
  | { readonly type: "commit-history"; readonly item: HistoryItem }
  | { readonly type: "start-compaction" }
  | { readonly type: "session-event"; readonly id: string; readonly event: SessionEvent }
  | { readonly type: "confirm-resolved" }
  | { readonly type: "user-input-resolved"; readonly requestId: PendingUserInput["requestId"] }
  | { readonly type: "cancel-requested" }
  | { readonly type: "turn-end" };

export interface InitialStateOptions {
  readonly history?: readonly HistoryItem[];
  readonly thinkingLevel?: ThinkingLevel;
  readonly thinkingDisplay?: ChatThinkingDisplay;
}

const EMPTY_LIVE: LiveState = {
  streamingText: "",
  reasoningId: undefined,
  reasoningText: "",
  reasoningActive: false,
  reasoningStartedAt: undefined,
  thinkTagOpen: false,
  activeTools: [],
  compacting: false,
  producedOutput: false,
};

function withThinkCarry(text: string, thinkTagOpen: boolean): string {
  return thinkTagOpen ? `<think>${text}` : text;
}

export function createInitialState(
  model: string,
  contextWindow: number | undefined,
  options?: InitialStateOptions,
): ChatUiState {
  return {
    history: options?.history ?? [],
    draft: "",
    live: EMPTY_LIVE,
    status: {
      model,
      contextWindow,
      turnUsage: undefined,
      sessionUsage: undefined,
      contextInputTokens: undefined,
      outputTokensPerSecond: undefined,
      thinkingLevel: options?.thinkingLevel ?? "medium",
      autoApprove: false,
    },
    phase: "idle",
    pendingConfirm: undefined,
    pendingUserInput: undefined,
    thinkingDisplay: options?.thinkingDisplay ?? "collapsed",
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
  const checkpoint = event.checkpointGeneration
    ? `，checkpoint #${String(event.checkpointGeneration)}${event.checkpointSummaryStatus && event.checkpointSummaryStatus !== "valid" ? `(${event.checkpointSummaryStatus})` : ""}`
    : "";
  if (event.removed === 0 && !event.truncatedTools) {
    return `${GLYPHS.compact} ${label}：无需压缩`;
  }
  return `${GLYPHS.compact} ${label}(${event.strategy})：移除 ${String(event.removed)} 条 → 保留 ${String(event.kept)} 条${tools}${checkpoint}`;
}

const DENIAL_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["已取消执行", "已取消"],
  ["策略拒绝执行", "策略拒绝"],
];

function toolOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "output" in value) {
    return typeof value.output === "string" ? value.output : undefined;
  }
  return undefined;
}

export function denialLabel(output: unknown): string | undefined {
  const text = toolOutputText(output);
  if (text === undefined) {
    return undefined;
  }
  return DENIAL_LABELS.find(([prefix]) => text.startsWith(prefix))?.[1];
}

function commitTool(
  state: ChatUiState,
  id: string,
  event: Extract<SessionEvent, { type: "tool-result" }>,
): ChatUiState {
  const active = state.live.activeTools.find((tool) => tool.toolCallId === event.toolCallId);
  const name = active?.name ?? `${event.agentName}.${event.toolName}`;
  const args = active?.args ?? "";
  const denial =
    event.outcome?.kind === TOOL_OUTCOME_KINDS.userRejected
      ? "已取消"
      : event.outcome?.kind === TOOL_OUTCOME_KINDS.policyDenied
        ? "策略拒绝"
        : event.outcome === undefined && event.isError
          ? denialLabel(event.output)
          : undefined;
  const item: HistoryItem =
    denial !== undefined
      ? { kind: "denied", id, name, label: denial }
      : { kind: "tool", id, name, args, ok: !event.isError };
  return {
    ...state,
    history: [...state.history, item],
    live: {
      ...state.live,
      activeTools: state.live.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId),
    },
  };
}

function commitStreamingText(state: ChatUiState, id: string): ChatUiState {
  if (state.live.streamingText.length === 0) {
    return state;
  }
  return {
    ...state,
    history: [
      ...state.history,
      {
        kind: "assistant",
        id,
        text: withThinkCarry(state.live.streamingText, state.live.thinkTagOpen),
      },
    ],
    live: {
      ...state.live,
      streamingText: "",
      thinkTagOpen: endsInsideThink(state.live.streamingText, state.live.thinkTagOpen),
    },
  };
}

function commitReasoning(state: ChatUiState, id: string): ChatUiState {
  const durationMs =
    state.live.reasoningStartedAt === undefined
      ? undefined
      : Math.max(0, Date.now() - state.live.reasoningStartedAt);
  const history =
    state.live.reasoningText.trim().length > 0
      ? [
          ...state.history,
          {
            kind: "reasoning",
            id,
            text: state.live.reasoningText,
            ...(durationMs !== undefined ? { durationMs } : {}),
          } as const,
        ]
      : state.history;
  return {
    ...state,
    history,
    live: {
      ...state.live,
      reasoningId: undefined,
      reasoningText: "",
      reasoningActive: false,
      reasoningStartedAt: undefined,
    },
  };
}

function beginReasoning(state: ChatUiState, id: string, reasoningId: string): ChatUiState {
  const afterReasoning = commitReasoning(state, `${id}-previous-reasoning`);
  const afterText = commitStreamingText(afterReasoning, id);
  return {
    ...afterText,
    live: {
      ...afterText.live,
      reasoningId,
      reasoningText: "",
      reasoningActive: true,
      reasoningStartedAt: Date.now(),
    },
  };
}

function applySessionEvent(state: ChatUiState, id: string, event: SessionEvent): ChatUiState {
  switch (event.type) {
    case "message-start":
      return state;
    case "reasoning-start":
      return beginReasoning(state, id, event.reasoningId);
    case "reasoning-delta": {
      const current =
        state.live.reasoningId === event.reasoningId
          ? state
          : beginReasoning(state, id, event.reasoningId);
      return {
        ...current,
        live: {
          ...current.live,
          reasoningText: current.live.reasoningText + event.delta,
          reasoningActive: true,
        },
      };
    }
    case "reasoning-end":
      return state.live.reasoningId === event.reasoningId
        ? commitReasoning(state, `${id}-reasoning`)
        : state;
    case "text-delta": {
      const current = commitReasoning(state, `${id}-reasoning`);
      return {
        ...current,
        live: {
          ...current.live,
          producedOutput: true,
          streamingText: current.live.streamingText + event.delta,
        },
      };
    }
    case "tool-call": {
      const afterReasoning = commitReasoning(state, `${id}-reasoning`);
      const current = commitStreamingText(afterReasoning, id);
      return {
        ...current,
        live: {
          ...current.live,
          producedOutput: true,
          activeTools: [
            ...current.live.activeTools,
            {
              toolCallId: event.toolCallId,
              name: `${event.agentName}.${event.toolName}`,
              args: formatToolInput(event.input),
            },
          ],
        },
      };
    }
    case "tool-output-delta": {
      const activeTools = state.live.activeTools.map((tool) => {
        if (tool.toolCallId !== event.toolCallId) {
          return tool;
        }
        const combined = `${tool.outputTail ?? ""}${event.delta}`;
        const outputTail =
          combined.length > MAX_TOOL_OUTPUT_TAIL_CHARS
            ? combined.slice(combined.length - MAX_TOOL_OUTPUT_TAIL_CHARS)
            : combined;
        return { ...tool, outputTail };
      });
      return { ...state, live: { ...state.live, activeTools } };
    }
    case "tool-result":
      return commitTool(state, id, event);
    case "confirmation-required": {
      const explanation =
        event.explanation === undefined ? undefined : formatApprovalExplanation(event.explanation);
      return {
        ...state,
        phase: "confirm",
        pendingConfirm: {
          approvalId: event.approvalId,
          prompt: buildConfirmPrompt(event),
          args: formatApprovalDetails(event.input),
          ...(explanation !== undefined ? { explanation } : {}),
          ...(event.sessionGrantLabel !== undefined
            ? { sessionGrantLabel: event.sessionGrantLabel }
            : {}),
        },
        pendingUserInput: undefined,
      };
    }
    case "user-input-required":
      return {
        ...state,
        phase: CHAT_PHASES.userInput,
        pendingConfirm: undefined,
        pendingUserInput: event,
      };
    case "user-input-settled":
      return state.pendingUserInput?.requestId === event.requestId
        ? { ...state, phase: CHAT_PHASES.busy, pendingUserInput: undefined }
        : state;
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
      const current = commitReasoning(state, `${id}-reasoning`);
      const committed: HistoryItem[] = [];
      if (current.live.streamingText.length > 0) {
        committed.push({
          kind: "assistant",
          id,
          text: withThinkCarry(current.live.streamingText, current.live.thinkTagOpen),
        });
      } else if (!current.live.producedOutput && (event.totalUsage?.outputTokens ?? 0) > 0) {
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
        ...current,
        history: [...current.history, ...committed],
        live: { ...EMPTY_LIVE },
        status: {
          ...current.status,
          turnUsage: event.totalUsage,
          sessionUsage: event.sessionUsage,
          contextInputTokens: event.contextInputTokens,
          outputTokensPerSecond: event.outputTokensPerSecond,
        },
      };
    }
    case "turn-cancelled": {
      const cancelledTools: HistoryItem[] = state.live.activeTools.map((tool, index) => ({
        kind: "cancelled",
        id: `${id}-tool-${String(index)}`,
        name: tool.name,
        args: tool.args,
      }));
      return {
        ...state,
        history: [
          ...state.history,
          ...cancelledTools,
          { kind: "turn-cancelled", id, text: event.message, reason: event.reason },
        ],
        live: { ...EMPTY_LIVE },
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
        history: [
          ...state.history,
          {
            kind: "user",
            id: action.id,
            text: action.text,
            ...(action.attachmentLabels !== undefined && action.attachmentLabels.length > 0
              ? { attachmentLabels: action.attachmentLabels }
              : {}),
          },
        ],
        draft: "",
        live: { ...EMPTY_LIVE },
        phase: "busy",
        pendingConfirm: undefined,
        pendingUserInput: undefined,
      };
    case "set-draft":
      return { ...state, draft: action.value };
    case "set-thinking":
      return { ...state, status: { ...state.status, thinkingLevel: action.level } };
    case "set-thinking-display":
      return { ...state, thinkingDisplay: action.value };
    case "set-auto":
      return { ...state, status: { ...state.status, autoApprove: action.value } };
    case "commit-history":
      return { ...state, history: [...state.history, action.item], draft: "" };
    case "start-compaction":
      return {
        ...state,
        live: { ...EMPTY_LIVE, compacting: true },
        phase: "busy",
        pendingConfirm: undefined,
        pendingUserInput: undefined,
      };
    case "session-event":
      return applySessionEvent(state, action.id, action.event);
    case "confirm-resolved":
      return { ...state, phase: "busy", pendingConfirm: undefined };
    case "user-input-resolved":
      return state.pendingUserInput?.requestId === action.requestId
        ? { ...state, phase: CHAT_PHASES.busy, pendingUserInput: undefined }
        : state;
    case "cancel-requested":
      return {
        ...state,
        phase: "cancelling",
        pendingConfirm: undefined,
        pendingUserInput: undefined,
      };
    case "turn-end":
      return {
        ...state,
        phase: "idle",
        live: { ...EMPTY_LIVE },
        pendingConfirm: undefined,
        pendingUserInput: undefined,
      };
    default:
      return state;
  }
}
