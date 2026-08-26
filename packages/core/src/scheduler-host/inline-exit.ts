import { EXECUTOR_LIVENESS, type ExecutorLiveness } from "@roll-agent/runtime";
import { KILL_PROCESS_TREE_OUTCOMES, type KillProcessTreeOutcome } from "./executor-liveness.ts";

export const INLINE_EXIT_DECISIONS = {
  fail: "fail",
  holdUnconfirmedKill: "hold-unconfirmed-kill",
  holdDescendants: "hold-descendants",
} as const;
export type InlineExitDecision = (typeof INLINE_EXIT_DECISIONS)[keyof typeof INLINE_EXIT_DECISIONS];

export function decideInlineExit(input: {
  readonly killOutcome: KillProcessTreeOutcome | undefined;
  readonly liveness: ExecutorLiveness | undefined;
}): InlineExitDecision {
  if (input.killOutcome !== undefined && input.killOutcome !== KILL_PROCESS_TREE_OUTCOMES.tree) {
    return INLINE_EXIT_DECISIONS.holdUnconfirmedKill;
  }
  if (input.liveness !== undefined && input.liveness !== EXECUTOR_LIVENESS.dead) {
    return INLINE_EXIT_DECISIONS.holdDescendants;
  }
  return INLINE_EXIT_DECISIONS.fail;
}
