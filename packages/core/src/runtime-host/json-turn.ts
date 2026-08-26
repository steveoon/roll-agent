import type { AgentSession } from "@roll-agent/runtime";
import type {
  ChatCommandResult,
  ChatCompactionSummary,
  ChatPendingAction,
  ChatStepSummary,
  ChatStepUsage,
  ChatTokenUsage,
} from "../types/chat.ts";

export async function runJsonTurn(
  session: AgentSession,
  message: string,
  stopSignal?: AbortSignal,
): Promise<ChatCommandResult> {
  const shouldStop = () => stopSignal?.aborted === true;
  if (shouldStop()) {
    return {
      status: "failed",
      stage: "execute",
      message: "本轮执行已收到停止请求",
      sessionId: session.id,
    };
  }
  const steps: ChatStepSummary[] = [];
  const stepUsages: ChatStepUsage[] = [];
  const compactions: ChatCompactionSummary[] = [];
  const pendingActions: ChatPendingAction[] = [];
  let output = "";
  let failure: string | undefined;
  let totalUsage: ChatTokenUsage | undefined;
  let sessionUsage: ChatTokenUsage | undefined;
  let contextInputTokens: number | undefined;
  let cancelled = false;
  const cancel = () => {
    if (!cancelled) {
      cancelled = session.cancel();
    }
  };
  stopSignal?.addEventListener("abort", cancel, { once: true });

  try {
    for await (const event of session.send(message)) {
      switch (event.type) {
        case "text-delta":
          output += event.delta;
          break;
        case "tool-call":
          steps.push({
            summary: `${event.agentName}.${event.toolName}`,
            agentName: event.agentName,
            toolName: event.toolName,
          });
          break;
        case "confirmation-required":
          pendingActions.push({
            summary: `${event.agentName}.${event.toolName}`,
            agentName: event.agentName,
            toolName: event.toolName,
          });
          session.reject(event.approvalId, "json 模式不支持交互确认");
          break;
        case "step-finish":
          stepUsages.push({
            finishReason: event.finishReason,
            ...(event.usage ? { usage: event.usage } : {}),
          });
          break;
        case "message-finish":
          totalUsage = event.totalUsage;
          sessionUsage = event.sessionUsage;
          contextInputTokens = event.contextInputTokens;
          break;
        case "context-compacted":
          compactions.push({
            reason: event.reason,
            strategy: event.strategy,
            removed: event.removed,
            kept: event.kept,
            ...(event.truncatedTools !== undefined ? { truncatedTools: event.truncatedTools } : {}),
            ...(event.beforeInputTokens !== undefined
              ? { beforeInputTokens: event.beforeInputTokens }
              : {}),
            ...(event.checkpointId !== undefined ? { checkpointId: event.checkpointId } : {}),
            ...(event.checkpointGeneration !== undefined
              ? { checkpointGeneration: event.checkpointGeneration }
              : {}),
            ...(event.checkpointSummaryStatus !== undefined
              ? { checkpointSummaryStatus: event.checkpointSummaryStatus }
              : {}),
          });
          break;
        case "turn-cancelled":
          failure = event.message;
          break;
        case "error":
          failure = event.message;
          break;
        default:
          break;
      }
      if (shouldStop()) {
        cancel();
      }
    }
  } finally {
    stopSignal?.removeEventListener("abort", cancel);
  }

  const contextWindow = session.getContextWindow();

  if (failure !== undefined) {
    return { status: "failed", stage: "execute", message: failure, sessionId: session.id };
  }
  if (pendingActions.length > 0) {
    return {
      status: "needs_confirmation",
      sessionId: session.id,
      message: "存在需要确认的工具调用，请在交互模式下执行或显式批准",
      pendingActions,
    };
  }
  return {
    status: "completed",
    sessionId: session.id,
    output,
    steps,
    ...(stepUsages.length > 0 ? { stepUsages } : {}),
    ...(totalUsage ? { totalUsage } : {}),
    ...(sessionUsage ? { sessionUsage } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextInputTokens !== undefined ? { contextInputTokens } : {}),
    ...(compactions.length > 0 ? { compactions } : {}),
  };
}
