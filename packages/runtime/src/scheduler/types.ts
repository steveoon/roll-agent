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
  treeUnsettled: "tree-unsettled",
} as const;
export type InvocationFailureOutcome =
  (typeof INVOCATION_FAILURE_OUTCOMES)[keyof typeof INVOCATION_FAILURE_OUTCOMES];

export const INVOCATION_TERMINAL_STATUSES = [
  INVOCATION_STATUSES.completed,
  INVOCATION_STATUSES.needsConfirmation,
  INVOCATION_STATUSES.failed,
] as const;

export const CANCEL_INVOCATION_OUTCOMES = {
  cancelled: "cancelled",
  notFound: "not-found",
  terminal: "terminal",
  ownershipChanged: "ownership-changed",
  executorAlive: "executor-alive",
  executorUnknown: "executor-unknown",
  treeUnsettled: "tree-unsettled",
} as const;
export type CancelInvocationOutcome =
  (typeof CANCEL_INVOCATION_OUTCOMES)[keyof typeof CANCEL_INVOCATION_OUTCOMES];

export interface CancelInvocationOptions {
  readonly abandon?: boolean;
  readonly expectedOwnershipToken?: string;
  readonly expectedAttempt?: number;
  readonly expectedClaimedBy?: string;
}

export const TRACKED_LEADER_STATES = {
  alive: "alive",
  exited: "exited",
  unknown: "unknown",
} as const;
export type TrackedLeaderState = (typeof TRACKED_LEADER_STATES)[keyof typeof TRACKED_LEADER_STATES];

export interface PersistedTrackedGroup {
  readonly pgid: number;
  readonly leaderState: TrackedLeaderState;
  readonly startToken?: string;
}

export interface FinalizeCancellationTree {
  readonly trackedGroups?: readonly PersistedTrackedGroup[];
  readonly unsettled: boolean;
  readonly survivorPids?: readonly number[];
}

export interface FinalizeCancellationInput {
  readonly id: string;
  readonly reason: string;
  readonly nowMs: number;
  readonly expectedAttempt: number;
  readonly expectedClaimedBy?: string;
  readonly expectedOwnershipToken?: string;
  readonly tree?: FinalizeCancellationTree;
  readonly abandon?: boolean;
}

export interface RemoveScheduleOptions {
  readonly abandon?: boolean;
}

export const EXECUTOR_LIVENESS = {
  alive: "alive",
  descendants: "descendants-alive",
  dead: "dead",
  unknown: "unknown",
} as const;
export type ExecutorLiveness = (typeof EXECUTOR_LIVENESS)[keyof typeof EXECUTOR_LIVENESS];

export interface ExecutorIdentity {
  readonly pid: number;
  readonly startToken: string;
}

export type ExecutorLivenessProbe = (executor: ExecutorIdentity) => ExecutorLiveness;

export const COMPLETE_INVOCATION_OUTCOMES = {
  written: "written",
  lostClaim: "lost-claim",
  treeUnsettled: "tree-unsettled",
} as const;
export type CompleteInvocationOutcome =
  (typeof COMPLETE_INVOCATION_OUTCOMES)[keyof typeof COMPLETE_INVOCATION_OUTCOMES];

export const INVOCATION_TREE_LIVENESS = {
  settled: "settled",
  unsettled: "unsettled",
  unavailable: "unavailable",
} as const;
export type InvocationTreeLiveness =
  (typeof INVOCATION_TREE_LIVENESS)[keyof typeof INVOCATION_TREE_LIVENESS];

export interface ScheduleRecord {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger: TriggerSpec;
  readonly status: ScheduleStatus;
  readonly authorityDigest: string | undefined;
  readonly maxRunMs: number | undefined;
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
  readonly maxAttempts: number;
  readonly executor: ExecutorIdentity | undefined;
  readonly claimedBy: string | undefined;
  readonly leaseUntilMs: number | undefined;
  readonly retryAtMs: number | undefined;
  readonly threadId: string | undefined;
  readonly outputExcerpt: string | undefined;
  readonly error: string | undefined;
  readonly pendingActions: readonly string[];
  readonly treeTrackedPgids: readonly number[];
  readonly treeTrackedGroups: readonly PersistedTrackedGroup[];
  readonly treeUnsettled: boolean;
  readonly treeSurvivorPids: readonly number[];
  readonly createdAtMs: number;
  readonly startedAtMs: number | undefined;
  readonly finishedAtMs: number | undefined;
}

/** Durable provenance; intentionally survives invocation retention and schedule removal. */
export interface ScheduleThreadReference {
  readonly invocationId: string;
  readonly attempt: number;
  readonly scheduleId: string;
  readonly threadId: string;
  readonly threadsDir: string;
  readonly name: string;
  readonly cwd: string;
  readonly scheduledForMs: number;
  readonly mode: InvocationMode;
  readonly createdAtMs: number;
}

export interface BackfillThreadReferenceInput {
  readonly invocationId: string;
  readonly expectedAttempt: number;
  readonly threadId: string;
  readonly threadsDir: string;
}

export interface RegisterThreadReferenceInput extends BackfillThreadReferenceInput {
  readonly ownershipToken: string;
}

export interface ScheduleRunHistoryEntry {
  readonly invocationId: string;
  readonly scheduleId: string;
  readonly scheduledForMs: number;
  readonly mode: InvocationMode;
  /** Absent after ledger retention/removal; never infer a terminal status from a thread. */
  readonly invocation: InvocationRecord | undefined;
  readonly references: readonly ScheduleThreadReference[];
}

export interface ScheduleHistoryTask {
  readonly scheduleId: string;
  readonly name: string;
  readonly cwd: string;
  readonly schedule: ScheduleRecord | undefined;
  readonly latestRun: ScheduleRunHistoryEntry | undefined;
}

export type InvocationTreeLivenessProbe = (record: InvocationRecord) => InvocationTreeLiveness;

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
  readonly authorityDigest?: string;
  readonly maxRunMs?: number;
}

export interface EnqueueManualInvocationOptions {
  readonly maxAttempts?: number;
}

export interface FailInvocationOptions {
  readonly terminal?: boolean;
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

export interface RecordInvocationTreeInput {
  readonly id: string;
  readonly ownershipToken: string;
  readonly trackedGroups?: readonly PersistedTrackedGroup[];
  readonly unsettled: boolean;
  readonly survivorPids?: readonly number[];
  readonly error?: string;
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
