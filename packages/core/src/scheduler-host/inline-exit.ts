import {
  EXECUTOR_LIVENESS,
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_STATUSES,
  SCHEDULER_LIMITS,
} from "@roll-agent/runtime";
import type { ExecutorLiveness, ScheduleStore } from "@roll-agent/runtime";
import { KILL_PROCESS_TREE_OUTCOMES, type KillProcessTreeOutcome } from "./executor-liveness.ts";
import type { SpawnedInvocation, SpawnedInvocationSignal } from "./spawn-invocation.ts";

export const INLINE_EXIT_DECISIONS = {
  fail: "fail",
  holdUnconfirmedKill: "hold-unconfirmed-kill",
  holdDescendants: "hold-descendants",
  holdUnverifiedLiveness: "hold-unverified-liveness",
} as const;
export type InlineExitDecision = (typeof INLINE_EXIT_DECISIONS)[keyof typeof INLINE_EXIT_DECISIONS];

export function isInlineTerminalSuccess(status: string | undefined): boolean {
  return (
    status === INVOCATION_STATUSES.completed || status === INVOCATION_STATUSES.needsConfirmation
  );
}

export function inlineProcessExitCode(status: string | undefined): 0 | 1 {
  return isInlineTerminalSuccess(status) ? 0 : 1;
}

export function decideInlineExit(input: {
  readonly killOutcome: KillProcessTreeOutcome | undefined;
  readonly liveness: ExecutorLiveness | undefined;
}): InlineExitDecision {
  if (input.liveness === EXECUTOR_LIVENESS.dead) {
    return INLINE_EXIT_DECISIONS.fail;
  }
  if (input.liveness === EXECUTOR_LIVENESS.descendants) {
    return INLINE_EXIT_DECISIONS.holdDescendants;
  }
  if (input.liveness === EXECUTOR_LIVENESS.alive || input.liveness === EXECUTOR_LIVENESS.unknown) {
    return INLINE_EXIT_DECISIONS.holdUnverifiedLiveness;
  }
  if (input.killOutcome !== undefined && input.killOutcome !== KILL_PROCESS_TREE_OUTCOMES.tree) {
    return INLINE_EXIT_DECISIONS.holdUnconfirmedKill;
  }
  return INLINE_EXIT_DECISIONS.fail;
}

export interface InlineStopForwarder {
  readonly forward: () => void;
  readonly escalate: () => void;
  readonly seal: () => void;
  readonly guardSignalsAfterRootExit: (maySignal: () => boolean) => void;
  readonly killOutcome: () => KillProcessTreeOutcome | undefined;
  readonly waitForPendingEscalation: () => Promise<boolean>;
}

export function armInlineRunTimeout(maxRunMs: number, onTimeout: () => void): () => void {
  const timer = setTimeout(onTimeout, maxRunMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export async function waitForInlineRootExit(
  exited: Promise<number | null>,
  forwarder: Pick<InlineStopForwarder, "seal">,
): Promise<number | null> {
  try {
    return await exited;
  } catch (error) {
    forwarder.seal();
    throw error;
  }
}

export function createInlineStopForwarder(
  handle: Pick<SpawnedInvocation, "kill">,
  platform: NodeJS.Platform = process.platform,
  graceMs: number = SCHEDULER_LIMITS.childTerminateGraceMs,
): InlineStopForwarder {
  let latest: KillProcessTreeOutcome | undefined;
  let sealed = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillWait: Promise<boolean> | undefined;
  let resolveForceKillWait: ((escalated: boolean) => void) | undefined;
  let forceKillEscalated = false;
  let forceKillGeneration = 0;
  let maySignalAfterRootExit: (() => boolean) | undefined;
  const cancelForceKillTimer = () => {
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };
  const settleForceKillWait = (escalated: boolean) => {
    const resolve = resolveForceKillWait;
    forceKillWait = undefined;
    resolveForceKillWait = undefined;
    resolve?.(escalated);
  };
  const clearForceKill = () => {
    cancelForceKillTimer();
    settleForceKillWait(false);
  };
  const send = (signal: SpawnedInvocationSignal): boolean => {
    if (sealed) {
      return false;
    }
    try {
      if (maySignalAfterRootExit !== undefined && !maySignalAfterRootExit()) {
        return false;
      }
    } catch {
      return false;
    }
    const outcome = handle.kill(signal);
    if (typeof outcome !== "string") {
      return true;
    }
    if (latest !== KILL_PROCESS_TREE_OUTCOMES.tree || outcome === KILL_PROCESS_TREE_OUTCOMES.tree) {
      latest = outcome;
    }
    return true;
  };
  return {
    forward: () => {
      forceKillGeneration += 1;
      if (platform === "win32") {
        forceKillEscalated = send("SIGKILL");
        return;
      }
      clearForceKill();
      forceKillEscalated = false;
      if (!send("SIGTERM")) {
        return;
      }
      const pending = Promise.withResolvers<boolean>();
      forceKillWait = pending.promise;
      resolveForceKillWait = pending.resolve;
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        forceKillEscalated = send("SIGKILL");
        settleForceKillWait(forceKillEscalated);
      }, graceMs);
      forceKillTimer.unref();
    },
    escalate: () => {
      cancelForceKillTimer();
      forceKillEscalated = send("SIGKILL");
      settleForceKillWait(forceKillEscalated);
    },
    seal: () => {
      clearForceKill();
      forceKillEscalated = false;
      sealed = true;
    },
    guardSignalsAfterRootExit: (maySignal) => {
      maySignalAfterRootExit = maySignal;
    },
    killOutcome: () => latest,
    waitForPendingEscalation: () => {
      const waitForCurrentEscalation = (): Promise<boolean> => {
        const generation = forceKillGeneration;
        forceKillTimer?.ref();
        const pending = forceKillWait;
        if (pending === undefined) {
          return Promise.resolve(forceKillEscalated);
        }
        return pending.then((escalated) =>
          !escalated && generation !== forceKillGeneration ? waitForCurrentEscalation() : escalated,
        );
      };
      return waitForCurrentEscalation();
    },
  };
}

export interface SettleInlineInvocationInput {
  readonly store: Pick<
    ScheduleStore,
    "getInvocation" | "probeExecutor" | "failInvocation" | "reclassifyTimedOutInvocation"
  >;
  readonly invocationId: string;
  readonly ownershipToken: string;
  readonly expectedAttempt: number;
  readonly killOutcome: KillProcessTreeOutcome | undefined;
  readonly exitCode: number | null;
  readonly timeoutError?: string;
  readonly timedOutAtMs?: number;
}

export function settleInlineInvocation(input: SettleInlineInvocationInput): InlineExitDecision {
  const record = input.store.getInvocation(input.invocationId);
  if (
    input.timeoutError !== undefined &&
    input.timedOutAtMs !== undefined &&
    (record?.status === INVOCATION_STATUSES.completed ||
      record?.status === INVOCATION_STATUSES.needsConfirmation)
  ) {
    const timeoutOutcome = input.store.reclassifyTimedOutInvocation({
      id: input.invocationId,
      expectedAttempt: input.expectedAttempt,
      error: input.timeoutError,
      timedOutAtMs: input.timedOutAtMs,
      nowMs: Date.now(),
    });
    if (
      timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.retryScheduled ||
      timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.terminal ||
      timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.terminalPaused
    ) {
      return INLINE_EXIT_DECISIONS.fail;
    }
    if (timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.treeUnsettled) {
      return INLINE_EXIT_DECISIONS.holdUnverifiedLiveness;
    }
    if (timeoutOutcome === INVOCATION_FAILURE_OUTCOMES.lostClaim) {
      return INLINE_EXIT_DECISIONS.fail;
    }
  }
  const liveness =
    record?.status === INVOCATION_STATUSES.running && record.executor !== undefined
      ? input.store.probeExecutor(record.executor)
      : undefined;
  const decision = decideInlineExit({ killOutcome: input.killOutcome, liveness });
  if (decision === INLINE_EXIT_DECISIONS.fail) {
    const outcome = input.store.failInvocation(
      input.invocationId,
      input.ownershipToken,
      input.timeoutError ??
        `exec 进程退出 code=${input.exitCode === null ? "null" : String(input.exitCode)}，未写入执行结果`,
    );
    if (outcome === INVOCATION_FAILURE_OUTCOMES.treeUnsettled) {
      return INLINE_EXIT_DECISIONS.holdUnverifiedLiveness;
    }
  }
  return decision;
}

export async function settleInlineAfterExit(
  input: Omit<SettleInlineInvocationInput, "killOutcome"> & {
    readonly forwarder: InlineStopForwarder;
  },
): Promise<InlineExitDecision> {
  const { forwarder, ...settlement } = input;
  forwarder.guardSignalsAfterRootExit(() => {
    const record = settlement.store.getInvocation(settlement.invocationId);
    return (
      record?.status === INVOCATION_STATUSES.running &&
      record.executor !== undefined &&
      settlement.store.probeExecutor(record.executor) === EXECUTOR_LIVENESS.descendants
    );
  });
  const settle = () =>
    settleInlineInvocation({ ...settlement, killOutcome: forwarder.killOutcome() });
  let decision: InlineExitDecision;
  try {
    decision = settle();
  } catch (error) {
    forwarder.seal();
    throw error;
  }
  if (decision !== INLINE_EXIT_DECISIONS.holdDescendants) {
    forwarder.seal();
    return decision;
  }
  const escalated = await forwarder.waitForPendingEscalation();
  try {
    return escalated ? settle() : decision;
  } finally {
    forwarder.seal();
  }
}
