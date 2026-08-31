import {
  AgentLifecycleBusyError,
  acquireAgentLifecycleLock,
  type AgentLifecycleLock,
} from "../registry/process-manager.ts";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { SCHEDULER_ADMISSION_LOCK_NAME } from "./paths.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
  inspectSchedulerServiceState,
  schedulerServiceStatePath,
} from "./service-state.ts";

type AcquireSchedulerAdmissionLock = (dataDir: string, lockName: string) => AgentLifecycleLock;

interface SchedulerAdmissionDependencies {
  readonly acquire?: AcquireSchedulerAdmissionLock;
  readonly lockRoot?: string;
  readonly statePath?: string;
}

export const SCHEDULER_ADMISSION_REFUSALS = {
  serviceState: "service-state",
  busy: "busy",
} as const;
export type SchedulerAdmissionRefusal =
  (typeof SCHEDULER_ADMISSION_REFUSALS)[keyof typeof SCHEDULER_ADMISSION_REFUSALS];

export type SchedulerAdmissionAttempt<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false; readonly reason: SchedulerAdmissionRefusal };

export const SCHEDULER_REPLACEMENT_OUTCOMES = {
  replaced: "replaced",
  refusedLiveRuns: "refused-live-runs",
} as const;
export type SchedulerReplacementOutcome =
  (typeof SCHEDULER_REPLACEMENT_OUTCOMES)[keyof typeof SCHEDULER_REPLACEMENT_OUTCOMES];

export interface SchedulerReplacementResult {
  readonly outcome: SchedulerReplacementOutcome;
  readonly liveInvocations: number;
}

export class SchedulerAdmissionBusyError extends Error {
  constructor() {
    super(
      "scheduler 正在领取任务或执行 service maintenance，请稍后重试；若持续出现，说明 service metadata 停在 installing 或无法解析，用 roll schedule service status 查看并以 roll schedule service restart 恢复",
    );
    this.name = "SchedulerAdmissionBusyError";
  }
}

function acquire(dependencies: SchedulerAdmissionDependencies): AgentLifecycleLock {
  return (dependencies.acquire ?? acquireAgentLifecycleLock)(
    dependencies.lockRoot ?? resolve(homedir(), ".roll-agent"),
    SCHEDULER_ADMISSION_LOCK_NAME,
  );
}

function serviceStateBlocksClaim(dataDir: string, statePath: string): boolean {
  const serviceState = inspectSchedulerServiceState(statePath);
  if (serviceState.status === "invalid") {
    return true;
  }
  if (
    serviceState.status === "missing" ||
    serviceState.state.phase !== SCHEDULER_SERVICE_STATE_PHASES.installing
  ) {
    return false;
  }
  const resolvedDataDir = resolve(dataDir);
  return [serviceState.state.dataDir, serviceState.state.replacementFrom?.dataDir]
    .filter((value): value is string => value !== undefined)
    .some((value) => resolve(value) === resolvedDataDir);
}

export function acquireSchedulerAdmissionLock(
  dependencies: SchedulerAdmissionDependencies = {},
): AgentLifecycleLock {
  try {
    return acquire(dependencies);
  } catch (error) {
    if (error instanceof AgentLifecycleBusyError) {
      throw new SchedulerAdmissionBusyError();
    }
    throw error;
  }
}

export function tryWithSchedulerAdmissionLock<T>(
  dataDir: string,
  work: () => T,
  dependencies: SchedulerAdmissionDependencies = {},
): SchedulerAdmissionAttempt<T> {
  const statePath = dependencies.statePath ?? schedulerServiceStatePath();
  if (serviceStateBlocksClaim(dataDir, statePath)) {
    return { acquired: false, reason: SCHEDULER_ADMISSION_REFUSALS.serviceState };
  }
  let lock: AgentLifecycleLock;
  try {
    lock = acquire(dependencies);
  } catch (error) {
    if (error instanceof AgentLifecycleBusyError) {
      return { acquired: false, reason: SCHEDULER_ADMISSION_REFUSALS.busy };
    }
    throw error;
  }
  try {
    if (serviceStateBlocksClaim(dataDir, statePath)) {
      return { acquired: false, reason: SCHEDULER_ADMISSION_REFUSALS.serviceState };
    }
    return { acquired: true, value: work() };
  } finally {
    lock.release();
  }
}

export function createSchedulerClaimDue<TInput, TResult extends readonly unknown[]>(
  dataDir: string,
  claimDue: (input: TInput) => TResult,
  dependencies: SchedulerAdmissionDependencies = {},
): (input: TInput) => TResult | [] | undefined {
  return (input) => {
    const attempt = tryWithSchedulerAdmissionLock(dataDir, () => claimDue(input), dependencies);
    if (attempt.acquired) {
      return attempt.value;
    }
    return attempt.reason === SCHEDULER_ADMISSION_REFUSALS.busy ? [] : undefined;
  };
}

export async function acquireSchedulerAdmissionLockWithRetry(
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
  dependencies: SchedulerAdmissionDependencies = {},
): Promise<AgentLifecycleLock> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 250;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return acquireSchedulerAdmissionLock(dependencies);
    } catch (error) {
      if (!(error instanceof SchedulerAdmissionBusyError) || attempt >= attempts) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export function admitSchedulerDaemonStart(
  dataDir: string,
  serviceGeneration: string | undefined,
  start: () => AgentLifecycleLock,
  dependencies: SchedulerAdmissionDependencies = {},
): AgentLifecycleLock {
  if (serviceGeneration !== undefined) {
    const statePath = dependencies.statePath ?? schedulerServiceStatePath();
    const generationMatches = () => {
      const inspection = inspectSchedulerServiceState(statePath);
      return (
        inspection.status === "valid" &&
        resolve(inspection.state.dataDir) === resolve(dataDir) &&
        inspection.state.generation === serviceGeneration
      );
    };
    if (!generationMatches()) {
      throw new Error(
        `scheduler service generation ${serviceGeneration} 与当前 installing/installed metadata 不匹配，拒绝启动`,
      );
    }
    const lock = start();
    if (generationMatches()) {
      return lock;
    }
    lock.release();
    throw new Error(
      `scheduler service generation ${serviceGeneration} 在 daemon lock 交接期间已失效，拒绝启动`,
    );
  }
  const attempt = tryWithSchedulerAdmissionLock(dataDir, start, dependencies);
  if (!attempt.acquired) {
    throw new SchedulerAdmissionBusyError();
  }
  return attempt.value;
}

export async function withSchedulerAdmissionLock<T>(
  work: () => Promise<T>,
  dependencies: SchedulerAdmissionDependencies = {},
): Promise<T> {
  const lock = acquireSchedulerAdmissionLock(dependencies);
  try {
    return await work();
  } finally {
    lock.release();
  }
}

export async function replaceSchedulerServiceWithAdmission(
  input: {
    readonly force: boolean;
    readonly countLive: () => Promise<number>;
    readonly replace: () => Promise<void>;
  },
  dependencies: SchedulerAdmissionDependencies = {},
): Promise<SchedulerReplacementResult> {
  return withSchedulerAdmissionLock(async () => {
    const liveInvocations = await input.countLive();
    if (liveInvocations > 0 && !input.force) {
      return {
        outcome: SCHEDULER_REPLACEMENT_OUTCOMES.refusedLiveRuns,
        liveInvocations,
      };
    }
    await input.replace();
    return { outcome: SCHEDULER_REPLACEMENT_OUTCOMES.replaced, liveInvocations };
  }, dependencies);
}
