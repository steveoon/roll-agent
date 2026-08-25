import type { InvocationRecord, ScheduleRecord } from "@roll-agent/runtime";
import { describeTrigger } from "@roll-agent/runtime";
import type { RollConfig } from "../../config/schema.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, type RuntimeModule } from "../../runtime-host/engine-factory.ts";
import { SCHEDULE_TOKEN_ENV } from "../../scheduler-host/paths.ts";

export type ScheduleStoreInstance = InstanceType<RuntimeModule["ScheduleStore"]>;

export function openScheduleStore(
  config: RollConfig,
  runtime: RuntimeModule,
): ScheduleStoreInstance {
  return new runtime.ScheduleStore(config.scheduler.dataDir, {
    maxSchedules: config.scheduler.maxSchedules,
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
    threadId: record.threadId,
    error: record.error,
    pendingActions: record.pendingActions,
    outputExcerpt: record.outputExcerpt,
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
