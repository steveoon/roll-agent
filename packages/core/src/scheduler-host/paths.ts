import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEDULER_SERVICE_LABEL = "dev.roll-agent.scheduler" as const;
export const WINDOWS_SCHEDULER_TASK_NAME = "Roll Agent Scheduler" as const;
export const SCHEDULER_DAEMON_LOCK_NAME = `${String.fromCharCode(0)}roll-scheduler-daemon`;
export const SCHEDULE_TOKEN_ENV = "ROLL_SCHEDULE_OWNERSHIP_TOKEN";

export interface SchedulerPaths {
  readonly dataDir: string;
  readonly logPath: string;
  readonly daemonRecordPath: string;
  readonly launchAgentPath: string;
}

export function createSchedulerPaths(dataDir: string, homeDir: string = homedir()): SchedulerPaths {
  return {
    dataDir,
    logPath: join(dataDir, "scheduler.log"),
    daemonRecordPath: join(dataDir, "daemon.json"),
    launchAgentPath: join(homeDir, "Library", "LaunchAgents", `${SCHEDULER_SERVICE_LABEL}.plist`),
  };
}
