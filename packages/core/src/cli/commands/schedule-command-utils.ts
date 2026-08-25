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
