import type { ContextCompactionFailure, SessionEvent } from "@roll-agent/runtime";

const FAILURE_LABELS: Readonly<Record<ContextCompactionFailure["reason"], string>> = {
  timeout: "超时",
  error: "失败",
};

/** Shared by Ink and the basic renderer; older events do not imply a failure cause. */
export function formatCompactionNoChange(
  event: Extract<SessionEvent, { type: "context-compacted" }>,
): string | undefined {
  const label = event.reason === "auto" ? "自动压缩" : "手动压缩";
  const failure = event.failure;
  if (failure !== undefined) {
    const timeout =
      failure.reason === "timeout" ? `（等待上限 ${String(failure.timeoutMs / 1000)} 秒）` : "";
    const hint = failure.reason === "timeout" ? "可调高压缩模型超时，或降低压缩推理强度。" : "";
    return `${label}${FAILURE_LABELS[failure.reason]}${timeout}，已保留原上下文。${hint}`;
  }
  if (event.recoveryNotice) return event.recoveryNotice;
  if (event.removed === 0 && !event.truncatedTools) {
    return `${label}：未减少上下文，已保留原上下文。`;
  }
  return undefined;
}
