import {
  createBundledRollInvocation,
  type BundledRollInvocation,
} from "../companion-host/invocation.ts";
import {
  createPlatformServiceController,
  type CompanionServiceController,
  type ServicePlanIdentity,
} from "../companion-host/service.ts";
import {
  SCHEDULER_SERVICE_LABEL,
  WINDOWS_SCHEDULER_TASK_NAME,
  createSchedulerPaths,
  type SchedulerPaths,
} from "./paths.ts";

export interface SchedulerServiceSettings {
  readonly maxConcurrentRuns: number;
}

export function schedulerServiceIdentity(
  paths: SchedulerPaths,
  invocation: BundledRollInvocation,
  settings: SchedulerServiceSettings,
): ServicePlanIdentity {
  return {
    label: SCHEDULER_SERVICE_LABEL,
    plistPath: paths.launchAgentPath,
    logPath: paths.logPath,
    windowsTaskName: WINDOWS_SCHEDULER_TASK_NAME,
    displayName: "roll schedule daemon",
    windowsTaskXmlPath: paths.windowsTaskXmlPath,
    programArguments: [
      invocation.command,
      ...invocation.execArgv,
      invocation.cliEntrypoint,
      "schedule",
      "daemon",
      "--foreground",
      "--data-dir",
      paths.dataDir,
      "--max-concurrent-runs",
      String(settings.maxConcurrentRuns),
    ],
  };
}

export function createSchedulerServiceController(options: {
  readonly dataDir: string;
  readonly maxConcurrentRuns: number;
  readonly invocation?: BundledRollInvocation;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}): CompanionServiceController {
  const paths = createSchedulerPaths(options.dataDir, options.homeDir);
  const invocation = options.invocation ?? createBundledRollInvocation();
  return createPlatformServiceController({
    identity: schedulerServiceIdentity(paths, invocation, {
      maxConcurrentRuns: options.maxConcurrentRuns,
    }),
    ...(options.platform ? { platform: options.platform } : {}),
  });
}
