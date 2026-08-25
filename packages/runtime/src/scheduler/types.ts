import type { TriggerSpec } from "./trigger.ts";

export const SCHEDULE_STATUSES = { active: "active", paused: "paused" } as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[keyof typeof SCHEDULE_STATUSES];

export const INVOCATION_MODES = { scheduled: "scheduled", manual: "manual" } as const;
export type InvocationMode = (typeof INVOCATION_MODES)[keyof typeof INVOCATION_MODES];

export const INVOCATION_STATUSES = {
  pending: "pending",
  claimed: "claimed",
  running: "running",
  retry: "retry",
  completed: "completed",
  needsConfirmation: "needs_confirmation",
  failed: "failed",
} as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[keyof typeof INVOCATION_STATUSES];

export const INVOCATION_LIVE_STATUSES = [
  INVOCATION_STATUSES.pending,
  INVOCATION_STATUSES.claimed,
  INVOCATION_STATUSES.running,
  INVOCATION_STATUSES.retry,
] as const;

export type CompleteInvocationStatus =
  | typeof INVOCATION_STATUSES.completed
  | typeof INVOCATION_STATUSES.needsConfirmation;

export const INVOCATION_FAILURE_OUTCOMES = {
  retryScheduled: "retry-scheduled",
  terminal: "terminal",
  terminalPaused: "terminal-paused",
  lostClaim: "lost-claim",
} as const;
export type InvocationFailureOutcome =
  (typeof INVOCATION_FAILURE_OUTCOMES)[keyof typeof INVOCATION_FAILURE_OUTCOMES];

export interface ScheduleRecord {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger: TriggerSpec;
  readonly status: ScheduleStatus;
  readonly nextRunAtMs: number | undefined;
  readonly lastRunAtMs: number | undefined;
  readonly lastError: string | undefined;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface InvocationRecord {
  readonly id: string;
  readonly scheduleId: string;
  readonly mode: InvocationMode;
  readonly status: InvocationStatus;
  readonly scheduledForMs: number;
  readonly attempt: number;
  readonly claimedBy: string | undefined;
  readonly leaseUntilMs: number | undefined;
  readonly retryAtMs: number | undefined;
  readonly threadId: string | undefined;
  readonly outputExcerpt: string | undefined;
  readonly error: string | undefined;
  readonly pendingActions: readonly string[];
  readonly createdAtMs: number;
  readonly startedAtMs: number | undefined;
  readonly finishedAtMs: number | undefined;
}

export interface ClaimedInvocation {
  readonly invocation: InvocationRecord;
  readonly schedule: ScheduleRecord;
  readonly ownershipToken: string;
}

export interface CreateScheduleInput {
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger: TriggerSpec;
  readonly fireImmediately?: boolean;
}

export interface CompleteInvocationInput {
  readonly id: string;
  readonly ownershipToken: string;
  readonly status: CompleteInvocationStatus;
  readonly nowMs: number;
  readonly threadId?: string;
  readonly outputExcerpt?: string;
  readonly pendingActions?: readonly string[];
}

export const SCHEDULE_STORE_ERROR_CODES = {
  limitReached: "schedule_limit_reached",
  notFound: "schedule_not_found",
  invalid: "schedule_invalid",
} as const;
export type ScheduleStoreErrorCode =
  (typeof SCHEDULE_STORE_ERROR_CODES)[keyof typeof SCHEDULE_STORE_ERROR_CODES];

export class ScheduleStoreError extends Error {
  readonly code: ScheduleStoreErrorCode;

  constructor(code: ScheduleStoreErrorCode, message: string) {
    super(message);
    this.name = "ScheduleStoreError";
    this.code = code;
  }
}
