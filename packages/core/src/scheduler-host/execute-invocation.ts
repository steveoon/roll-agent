import { SCHEDULER_LIMITS } from "@roll-agent/runtime";
import type {
  ExecutorIdentity,
  InvocationFailureOutcome,
  InvocationRecord,
  ScheduleRecord,
  ScheduleStore,
} from "@roll-agent/runtime";
import {
  INVOCATION_TREE_TEARDOWN_OUTCOMES,
  type InvocationTreeTeardown,
} from "./invocation-tree.ts";

export const INVOCATION_TREE_TEARDOWN_PHASES = {
  preflight: "preflight",
  settle: "settle",
} as const;

export type InvocationTreeTeardownPhase =
  (typeof INVOCATION_TREE_TEARDOWN_PHASES)[keyof typeof INVOCATION_TREE_TEARDOWN_PHASES];

export const SCHEDULED_TURN_STATUSES = {
  completed: "completed",
  needsConfirmation: "needs_confirmation",
  failed: "failed",
} as const;

export type ScheduledTurnOutcome =
  | {
      readonly status: typeof SCHEDULED_TURN_STATUSES.completed;
      readonly threadId: string;
      readonly output: string;
    }
  | {
      readonly status: typeof SCHEDULED_TURN_STATUSES.needsConfirmation;
      readonly threadId: string;
      readonly output: string;
      readonly pendingActions: readonly string[];
    }
  | {
      readonly status: typeof SCHEDULED_TURN_STATUSES.failed;
      readonly threadId?: string;
      readonly error: string;
      readonly terminal?: boolean;
    };

export type ScheduledTurnRunner = (
  schedule: ScheduleRecord,
  invocation: InvocationRecord,
) => Promise<ScheduledTurnOutcome>;

export const EXECUTE_INVOCATION_KINDS = {
  completed: "completed",
  needsConfirmation: "needs_confirmation",
  failed: "failed",
  lostClaim: "lost-claim",
  interrupted: "interrupted",
  unsettled: "unsettled",
} as const;

export type ExecuteInvocationResult =
  | {
      readonly kind:
        | typeof EXECUTE_INVOCATION_KINDS.completed
        | typeof EXECUTE_INVOCATION_KINDS.needsConfirmation;
      readonly invocationId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: typeof EXECUTE_INVOCATION_KINDS.failed;
      readonly invocationId: string;
      readonly error: string;
      readonly outcome: InvocationFailureOutcome;
    }
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.lostClaim; readonly invocationId: string }
  | {
      readonly kind: typeof EXECUTE_INVOCATION_KINDS.interrupted;
      readonly invocationId: string;
      readonly error: string;
    }
  | {
      readonly kind: typeof EXECUTE_INVOCATION_KINDS.unsettled;
      readonly invocationId: string;
      readonly survivorPids: readonly number[];
      readonly error: string;
    };

export interface ExecuteInvocationOptions {
  readonly store: ScheduleStore;
  readonly invocationId: string;
  readonly ownershipToken: string;
  readonly runTurn: ScheduledTurnRunner;
  readonly teardownTree: (phase: InvocationTreeTeardownPhase) => Promise<InvocationTreeTeardown>;
  readonly onTeardown?: (
    phase: InvocationTreeTeardownPhase,
    report: InvocationTreeTeardown,
  ) => void;
  readonly executor?: ExecutorIdentity;
  readonly now?: () => number;
  readonly maxOutputExcerptChars?: number;
  readonly stopSignal?: AbortSignal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTreeSettled(report: InvocationTreeTeardown): boolean {
  return (
    report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.clean ||
    report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported
  );
}

function describeSurvivors(report: InvocationTreeTeardown): string {
  return report.survivorPids.map(String).join(", ");
}

function describeUnsettled(report: InvocationTreeTeardown): string {
  if (report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable) {
    return "无法枚举本次运行拉起的进程，拒绝在无法验证进程树已退出时写入结果";
  }
  return `本次运行拉起的进程在强制终止后仍存活（pid ${describeSurvivors(report)}），拒绝在其仍存活时写入结果`;
}

function describePreflightFailure(report: InvocationTreeTeardown): string {
  if (report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable) {
    return "无法枚举上一次尝试的残留进程，拒绝在无法验证时运行";
  }
  return `上一次尝试的残留进程无法终止（pid ${describeSurvivors(report)}），拒绝在其仍存活时再次运行`;
}

export async function executeInvocation(
  options: ExecuteInvocationOptions,
): Promise<ExecuteInvocationResult> {
  const now = options.now ?? Date.now;
  const maxChars = options.maxOutputExcerptChars ?? SCHEDULER_LIMITS.maxOutputExcerptChars;
  const begun = options.store.beginInvocation(
    options.invocationId,
    options.ownershipToken,
    now(),
    options.executor,
  );
  if (begun === undefined) {
    return { kind: EXECUTE_INVOCATION_KINDS.lostClaim, invocationId: options.invocationId };
  }
  const teardown = async (phase: InvocationTreeTeardownPhase): Promise<InvocationTreeTeardown> => {
    const report = await options.teardownTree(phase);
    options.onTeardown?.(phase, report);
    return report;
  };
  const preflight = await teardown(INVOCATION_TREE_TEARDOWN_PHASES.preflight);
  if (!isTreeSettled(preflight)) {
    const message = describePreflightFailure(preflight);
    const failure = options.store.failInvocation(
      options.invocationId,
      options.ownershipToken,
      message,
      now(),
    );
    return {
      kind: EXECUTE_INVOCATION_KINDS.failed,
      invocationId: options.invocationId,
      error: message,
      outcome: failure,
    };
  }
  const interruptedBy = (error: string): ExecuteInvocationResult | undefined =>
    options.stopSignal?.aborted === true
      ? { kind: EXECUTE_INVOCATION_KINDS.interrupted, invocationId: options.invocationId, error }
      : undefined;
  const unsettledBy = (report: InvocationTreeTeardown): ExecuteInvocationResult => ({
    kind: EXECUTE_INVOCATION_KINDS.unsettled,
    invocationId: options.invocationId,
    survivorPids: report.survivorPids,
    error: describeUnsettled(report),
  });
  let outcome: ScheduledTurnOutcome;
  try {
    outcome = await options.runTurn(begun.schedule, begun.invocation);
  } catch (error) {
    const message = errorMessage(error);
    const settled = await teardown(INVOCATION_TREE_TEARDOWN_PHASES.settle);
    const interrupted = interruptedBy(message);
    if (interrupted !== undefined) {
      return interrupted;
    }
    if (!isTreeSettled(settled)) {
      return unsettledBy(settled);
    }
    const failure = options.store.failInvocation(
      options.invocationId,
      options.ownershipToken,
      message,
      now(),
    );
    return {
      kind: EXECUTE_INVOCATION_KINDS.failed,
      invocationId: options.invocationId,
      error: message,
      outcome: failure,
    };
  }
  const settled = await teardown(INVOCATION_TREE_TEARDOWN_PHASES.settle);
  if (outcome.status === SCHEDULED_TURN_STATUSES.failed) {
    const interrupted = interruptedBy(outcome.error);
    if (interrupted !== undefined) {
      return interrupted;
    }
    if (!isTreeSettled(settled)) {
      return unsettledBy(settled);
    }
    const failure = options.store.failInvocation(
      options.invocationId,
      options.ownershipToken,
      outcome.error,
      now(),
      { terminal: outcome.terminal === true },
    );
    return {
      kind: EXECUTE_INVOCATION_KINDS.failed,
      invocationId: options.invocationId,
      error: outcome.error,
      outcome: failure,
    };
  }
  if (!isTreeSettled(settled)) {
    return unsettledBy(settled);
  }
  const written = options.store.completeInvocation({
    id: options.invocationId,
    ownershipToken: options.ownershipToken,
    status: outcome.status,
    nowMs: now(),
    threadId: outcome.threadId,
    outputExcerpt: outcome.output.slice(0, maxChars),
    ...(outcome.status === SCHEDULED_TURN_STATUSES.needsConfirmation
      ? { pendingActions: outcome.pendingActions }
      : {}),
  });
  if (!written) {
    return { kind: EXECUTE_INVOCATION_KINDS.lostClaim, invocationId: options.invocationId };
  }
  return { kind: outcome.status, invocationId: options.invocationId, threadId: outcome.threadId };
}
