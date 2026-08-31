import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SCHEDULER_SERVICE_LABEL = "dev.roll-agent.scheduler" as const;
export const WINDOWS_SCHEDULER_TASK_NAME = "Roll Agent Scheduler" as const;
export const SCHEDULER_DAEMON_LOCK_NAME = `${String.fromCharCode(0)}roll-scheduler-daemon`;
export const SCHEDULER_ADMISSION_LOCK_NAME = `${String.fromCharCode(0)}roll-scheduler-admission`;
export const SCHEDULE_TOKEN_ENV = "ROLL_SCHEDULE_OWNERSHIP_TOKEN";
export const SCHEDULE_DATA_DIR_ENV = "ROLL_SCHEDULE_DATA_DIR";
export const SCHEDULE_INVOCATION_ENV = "ROLL_SCHEDULE_INVOCATION";

export function omitScheduleInvocationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!(SCHEDULE_INVOCATION_ENV in env)) {
    return { ...env };
  }
  const next: NodeJS.ProcessEnv = { ...env };
  delete next[SCHEDULE_INVOCATION_ENV];
  return next;
}

export interface SchedulerPaths {
  readonly dataDir: string;
  readonly logPath: string;
  readonly daemonRecordPath: string;
  readonly launchAgentPath: string;
  readonly windowsTaskXmlPath: string;
}

export function createSchedulerPaths(dataDir: string, homeDir: string = homedir()): SchedulerPaths {
  const resolvedDataDir = resolve(dataDir);
  return {
    dataDir: resolvedDataDir,
    logPath: join(resolvedDataDir, "scheduler.log"),
    daemonRecordPath: join(resolvedDataDir, "daemon.json"),
    launchAgentPath: join(homeDir, "Library", "LaunchAgents", `${SCHEDULER_SERVICE_LABEL}.plist`),
    windowsTaskXmlPath: join(resolvedDataDir, "scheduler-task.xml"),
  };
}
