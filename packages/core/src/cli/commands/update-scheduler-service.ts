import {
  SCHEDULER_SERVICE_RESTART_ACTIONS,
  type SchedulerServiceRestartAction,
} from "../../scheduler-host/service-plan.ts";

export const SCHEDULER_UPDATE_RECONCILE_OUTCOMES = {
  notInstalled: "not-installed",
  restarted: "restarted",
  deferred: "deferred",
  failed: "failed",
} as const;

export type SchedulerUpdateReconcileResult =
  | { readonly outcome: typeof SCHEDULER_UPDATE_RECONCILE_OUTCOMES.notInstalled }
  | { readonly outcome: typeof SCHEDULER_UPDATE_RECONCILE_OUTCOMES.restarted }
  | {
      readonly outcome: typeof SCHEDULER_UPDATE_RECONCILE_OUTCOMES.deferred;
      readonly reason: string;
    }
  | {
      readonly outcome: typeof SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed;
      readonly error: string;
    };

export interface SchedulerServiceRestartRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SchedulerServiceRestartOutput {
  readonly action: SchedulerServiceRestartAction;
  readonly liveInvocations: number;
  readonly reason?: string;
}

const RESTART_ACTIONS = new Set<string>(Object.values(SCHEDULER_SERVICE_RESTART_ACTIONS));

function isRestartAction(value: unknown): value is SchedulerServiceRestartAction {
  return typeof value === "string" && RESTART_ACTIONS.has(value);
}

export function parseSchedulerServiceRestartOutput(
  stdout: string,
): SchedulerServiceRestartOutput | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (!isRestartAction(record.action) || typeof record.liveInvocations !== "number") {
    return undefined;
  }
  return {
    action: record.action,
    liveInvocations: record.liveInvocations,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string): string {
  return text.trim().slice(-600);
}

export async function reconcileSchedulerServiceAfterUpdate(
  runRestart: () => Promise<SchedulerServiceRestartRun>,
): Promise<SchedulerUpdateReconcileResult> {
  let run: SchedulerServiceRestartRun;
  try {
    run = await runRestart();
  } catch (error) {
    return { outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed, error: errorMessage(error) };
  }
  const parsed = parseSchedulerServiceRestartOutput(run.stdout);
  if (parsed === undefined) {
    return {
      outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed,
      error: `roll schedule service restart --json 未返回可解析结果（exit ${run.exitCode === null ? "null" : String(run.exitCode)}）：${tail(run.stderr || run.stdout) || "无输出"}`,
    };
  }
  const outcomes: Record<SchedulerServiceRestartAction, () => SchedulerUpdateReconcileResult> = {
    [SCHEDULER_SERVICE_RESTART_ACTIONS.restart]: () =>
      run.exitCode === 0
        ? { outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.restarted }
        : {
            outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.failed,
            error: `roll schedule service restart 退出码 ${run.exitCode === null ? "null" : String(run.exitCode)}：${tail(run.stderr) || "无输出"}`,
          },
    [SCHEDULER_SERVICE_RESTART_ACTIONS.refuseLiveRuns]: () => ({
      outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.deferred,
      reason:
        parsed.reason ??
        `${String(parsed.liveInvocations)} 个 invocation 仍在占用；空闲后运行 roll schedule service restart`,
    }),
    [SCHEDULER_SERVICE_RESTART_ACTIONS.notInstalled]: () => ({
      outcome: SCHEDULER_UPDATE_RECONCILE_OUTCOMES.notInstalled,
    }),
  };
  return outcomes[parsed.action]();
}
