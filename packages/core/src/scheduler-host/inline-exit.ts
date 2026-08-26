import { EXECUTOR_LIVENESS, INVOCATION_STATUSES } from "@roll-agent/runtime";
import type { ExecutorLiveness, ScheduleStore } from "@roll-agent/runtime";
import { KILL_PROCESS_TREE_OUTCOMES, type KillProcessTreeOutcome } from "./executor-liveness.ts";
import type { SpawnedInvocation, SpawnedInvocationSignal } from "./spawn-invocation.ts";

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

export interface InlineStopForwarder {
  readonly forward: () => void;
  readonly escalate: () => void;
  readonly killOutcome: () => KillProcessTreeOutcome | undefined;
}

export function createInlineStopForwarder(
  handle: Pick<SpawnedInvocation, "kill">,
  platform: NodeJS.Platform = process.platform,
): InlineStopForwarder {
  let latest: KillProcessTreeOutcome | undefined;
  const send = (signal: SpawnedInvocationSignal) => {
    const outcome = handle.kill(signal);
    if (typeof outcome === "string") {
      latest = outcome;
    }
  };
  return {
    forward: () => {
      send(platform === "win32" ? "SIGKILL" : "SIGTERM");
    },
    escalate: () => {
      send("SIGKILL");
    },
    killOutcome: () => latest,
  };
}

export function settleInlineInvocation(input: {
  readonly store: Pick<ScheduleStore, "getInvocation" | "probeExecutor" | "failInvocation">;
  readonly invocationId: string;
  readonly ownershipToken: string;
  readonly killOutcome: KillProcessTreeOutcome | undefined;
  readonly exitCode: number | null;
}): InlineExitDecision {
  const record = input.store.getInvocation(input.invocationId);
  const liveness =
    record?.status === INVOCATION_STATUSES.running && record.executor !== undefined
      ? input.store.probeExecutor(record.executor)
      : undefined;
  const decision = decideInlineExit({ killOutcome: input.killOutcome, liveness });
  if (decision === INLINE_EXIT_DECISIONS.fail) {
    input.store.failInvocation(
      input.invocationId,
      input.ownershipToken,
      `exec 进程退出 code=${input.exitCode === null ? "null" : String(input.exitCode)}，未写入执行结果`,
    );
  }
  return decision;
}
