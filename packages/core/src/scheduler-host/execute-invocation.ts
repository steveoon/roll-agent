import { SCHEDULER_LIMITS } from "@roll-agent/runtime";
import type {
  ExecutorIdentity,
  InvocationFailureOutcome,
  InvocationRecord,
  ScheduleRecord,
  ScheduleStore,
} from "@roll-agent/runtime";

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
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.lostClaim; readonly invocationId: string };

export interface ExecuteInvocationOptions {
  readonly store: ScheduleStore;
  readonly invocationId: string;
  readonly ownershipToken: string;
  readonly runTurn: ScheduledTurnRunner;
  readonly executor?: ExecutorIdentity;
  readonly now?: () => number;
  readonly maxOutputExcerptChars?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  let outcome: ScheduledTurnOutcome;
  try {
    outcome = await options.runTurn(begun.schedule, begun.invocation);
  } catch (error) {
    const message = errorMessage(error);
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
  if (outcome.status === SCHEDULED_TURN_STATUSES.failed) {
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
