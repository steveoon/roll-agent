import type { InvocationRecord, ScheduleRecord } from "@roll-agent/runtime";
import { describeTrigger, formatDuration } from "@roll-agent/runtime";
import type { RollConfig } from "../../config/schema.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, type RuntimeModule } from "../../runtime-host/engine-factory.ts";
import { probeExecutorLiveness } from "../../scheduler-host/executor-liveness.ts";
import {
  probeInvocationTreeSettled,
  trackedGroupsFromPersisted,
  type InvocationTreeScope,
} from "../../scheduler-host/invocation-tree.ts";
import { SCHEDULE_TOKEN_ENV } from "../../scheduler-host/paths.ts";
import { backfillScheduleThreadReferences } from "../../scheduler-host/schedule-history.ts";

export type ScheduleStoreInstance = InstanceType<RuntimeModule["ScheduleStore"]>;

export interface OpenScheduleStoreOptions {
  readonly dataDir?: string;
  readonly requireExistingDatabase?: boolean;
}

export function openScheduleStore(
  config: RollConfig | undefined,
  runtime: RuntimeModule,
  options: OpenScheduleStoreOptions = {},
): ScheduleStoreInstance {
  const dataDir = options.dataDir ?? config?.scheduler.dataDir;
  if (dataDir === undefined) {
    throw new Error("无法确定 scheduler data-dir");
  }
  const store = new runtime.ScheduleStore(dataDir, {
    ...(config ? { maxSchedules: config.scheduler.maxSchedules } : {}),
    executorLiveness: probeExecutorLiveness,
    treeLiveness: (record) => probeInvocationTreeSettled(invocationTreeScopeFor(record)),
    ...(options.requireExistingDatabase === true ? { requireExistingDatabase: true } : {}),
  });
  try {
    backfillScheduleThreadReferences(config, runtime, store, dataDir);
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

export async function runScheduleCommand(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    log.error(error instanceof Error ? error.message : "roll schedule 命令执行失败");
    process.exitCode = 1;
  }
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export { loadRuntime, SCHEDULE_TOKEN_ENV };

function isoOrUndefined(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

export function invocationTreeScopeFor(
  record: Pick<InvocationRecord, "id" | "executor" | "treeTrackedGroups">,
): InvocationTreeScope {
  return {
    invocationId: record.id,
    selfPid: 0,
    trackedGroups: trackedGroupsFromPersisted(record.treeTrackedGroups),
    ...(record.executor !== undefined ? { previousExecutorPid: record.executor.pid } : {}),
  };
}

export function serializeSchedule(record: ScheduleRecord) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    trigger: describeTrigger(record.trigger),
    cwd: record.cwd,
    prompt: record.prompt,
    nextRunAt: isoOrUndefined(record.nextRunAtMs),
    lastRunAt: isoOrUndefined(record.lastRunAtMs),
    lastError: record.lastError,
    authorityDigest: record.authorityDigest,
    maxRun: record.maxRunMs === undefined ? undefined : formatDuration(record.maxRunMs),
    maxRunMs: record.maxRunMs,
    createdAt: new Date(record.createdAtMs).toISOString(),
  };
}

export function serializeInvocation(record: InvocationRecord) {
  return {
    id: record.id,
    scheduleId: record.scheduleId,
    mode: record.mode,
    status: record.status,
    scheduledFor: new Date(record.scheduledForMs).toISOString(),
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    executorPid: record.executor?.pid,
    threadId: record.threadId,
    error: record.error,
    pendingActions: record.pendingActions,
    outputExcerpt: record.outputExcerpt,
    treeUnsettled: record.treeUnsettled,
    treeSurvivorPids: record.treeSurvivorPids,
    treeTrackedGroups: record.treeTrackedGroups,
    startedAt: isoOrUndefined(record.startedAtMs),
    finishedAt: isoOrUndefined(record.finishedAtMs),
  };
}

export type SerializedSchedule = ReturnType<typeof serializeSchedule>;
export type SerializedInvocation = ReturnType<typeof serializeInvocation>;

export function describeUnsettledTree(
  row: Pick<SerializedInvocation, "treeUnsettled" | "treeSurvivorPids">,
): string | undefined {
  if (!row.treeUnsettled) {
    return undefined;
  }
  return row.treeSurvivorPids.length > 0
    ? `tree=unsettled(pid ${row.treeSurvivorPids.join(", ")})`
    : "tree=unsettled";
}

export function formatInvocationLine(row: SerializedInvocation): string {
  const tree = describeUnsettledTree(row);
  return `${row.status.padEnd(19)} ${row.scheduledFor}  attempt=${String(row.attempt)}  thread=${row.threadId ?? "-"}${tree === undefined ? "" : `  ${tree}`}${row.error ? `  ${row.error}` : ""}`;
}

export type ScheduleLiveRunHint =
  | {
      readonly kind: "held";
      readonly invocationId: string;
      readonly status: string;
      readonly survivorPids: readonly number[];
    }
  | { readonly kind: "unreadable"; readonly message: string };

export function liveRunHint(
  store: Pick<ScheduleStoreInstance, "findLiveRun">,
  scheduleId: string,
): ScheduleLiveRunHint | undefined {
  try {
    const live = store.findLiveRun(scheduleId);
    if (live === undefined || !live.treeUnsettled) {
      return undefined;
    }
    return {
      kind: "held",
      invocationId: live.id,
      status: live.status,
      survivorPids: live.treeSurvivorPids,
    };
  } catch (error) {
    return { kind: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
}

export function formatScheduleLine(row: SerializedSchedule, hint?: ScheduleLiveRunHint): string {
  const maxRun = row.maxRun === undefined ? "" : `max-run=${row.maxRun}  `;
  const base = `${row.id}  ${row.status.padEnd(6)}  ${row.trigger.padEnd(10)}  next=${row.nextRunAt ?? "-"}  ${maxRun}${row.name}${row.lastError ? `  ⚠ ${row.lastError}` : ""}`;
  if (hint === undefined) {
    return base;
  }
  if (hint.kind === "unreadable") {
    return `${base}  ⚠ ${hint.message}`;
  }
  const pids = hint.survivorPids.length > 0 ? `，残留 pid ${hint.survivorPids.join(", ")}` : "";
  return `${base}  ⚠ 运行 ${hint.invocationId}（${hint.status}）进程树未清${pids}；任务不再触发，用 roll schedule cancel ${hint.invocationId} --kill 清场`;
}

export function requireSchedule(store: ScheduleStoreInstance, id: string): ScheduleRecord {
  const record = store.getSchedule(id);
  if (record === undefined) {
    throw new Error(`定时任务 ${id} 不存在；用 roll schedule list 查看`);
  }
  return record;
}
