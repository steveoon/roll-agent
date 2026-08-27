import type { InvocationRecord, ScheduleRecord } from "@roll-agent/runtime";
import { describeTrigger } from "@roll-agent/runtime";
import type { RollConfig } from "../../config/schema.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, type RuntimeModule } from "../../runtime-host/engine-factory.ts";
import { probeExecutorLiveness } from "../../scheduler-host/executor-liveness.ts";
import {
  probeInvocationTreeSettled,
  trackedGroupsFromPersisted,
} from "../../scheduler-host/invocation-tree.ts";
import { SCHEDULE_TOKEN_ENV } from "../../scheduler-host/paths.ts";

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
  return new runtime.ScheduleStore(dataDir, {
    ...(config ? { maxSchedules: config.scheduler.maxSchedules } : {}),
    executorLiveness: probeExecutorLiveness,
    treeLiveness: (record) =>
      probeInvocationTreeSettled({
        invocationId: record.id,
        selfPid: record.executor?.pid ?? 0,
        trackedGroups: trackedGroupsFromPersisted(record.treeTrackedGroups),
        ...(record.executor !== undefined ? { previousExecutorPid: record.executor.pid } : {}),
      }),
    ...(options.requireExistingDatabase === true ? { requireExistingDatabase: true } : {}),
  });
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

export function requireSchedule(store: ScheduleStoreInstance, id: string): ScheduleRecord {
  const record = store.getSchedule(id);
  if (record === undefined) {
    throw new Error(`定时任务 ${id} 不存在；用 roll schedule list 查看`);
  }
  return record;
}
