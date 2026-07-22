import { CHAT_PHASES, type ChatUiState } from "./state.ts";
import { endsInsideThink } from "./thinking-text.ts";

export const TURN_ACTIVITY_KINDS = {
  waitingModel: "waiting-model",
  reasoning: "reasoning",
  replying: "replying",
  tool: "tool",
  compacting: "compacting",
  waitingUser: "waiting-user",
  cancelling: "cancelling",
} as const;

export type TurnActivityKind = (typeof TURN_ACTIVITY_KINDS)[keyof typeof TURN_ACTIVITY_KINDS];

export interface TurnActivity {
  readonly kind: TurnActivityKind;
  readonly key: string;
  readonly label: string;
  readonly animated: boolean;
  readonly showPhaseElapsed: boolean;
}

function activity(
  kind: TurnActivityKind,
  label: string,
  options?: { readonly key?: string; readonly animated?: boolean; readonly timed?: boolean },
): TurnActivity {
  return {
    kind,
    key: options?.key ?? kind,
    label,
    animated: options?.animated ?? true,
    showPhaseElapsed: options?.timed ?? true,
  };
}

export function resolveTurnActivity(state: ChatUiState): TurnActivity | undefined {
  if (state.phase === CHAT_PHASES.idle) {
    return undefined;
  }
  if (state.phase === CHAT_PHASES.cancelling) {
    return activity(TURN_ACTIVITY_KINDS.cancelling, "正在中断…");
  }
  if (state.phase === CHAT_PHASES.confirm) {
    return activity(TURN_ACTIVITY_KINDS.waitingUser, "等待你确认…", {
      key: `waiting-user:${state.pendingConfirm?.approvalId ?? "unknown"}`,
      animated: false,
      timed: false,
    });
  }
  if (state.live.compacting) {
    return activity(TURN_ACTIVITY_KINDS.compacting, "压缩上下文中…");
  }
  const firstTool = state.live.activeTools[0];
  if (firstTool !== undefined) {
    const extra = state.live.activeTools.length - 1;
    const suffix = extra > 0 ? ` 等 ${String(state.live.activeTools.length)} 项` : "";
    return activity(TURN_ACTIVITY_KINDS.tool, `执行 ${firstTool.name}${suffix}…`, {
      key: `tool:${state.live.activeTools.map((tool) => tool.toolCallId).join(",")}`,
    });
  }
  if (state.live.reasoningActive) {
    return activity(TURN_ACTIVITY_KINDS.reasoning, "思考中…");
  }
  if (
    state.live.streamingText.length > 0 &&
    endsInsideThink(state.live.streamingText, state.live.thinkTagOpen)
  ) {
    return activity(TURN_ACTIVITY_KINDS.reasoning, "思考中…", { key: "inline-reasoning" });
  }
  if (state.live.streamingText.length > 0) {
    return activity(TURN_ACTIVITY_KINDS.replying, "回复中…");
  }
  return activity(TURN_ACTIVITY_KINDS.waitingModel, "等待模型响应…");
}
