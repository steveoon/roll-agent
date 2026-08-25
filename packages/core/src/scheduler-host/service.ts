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

export function schedulerServiceIdentity(
  paths: SchedulerPaths,
  invocation: BundledRollInvocation,
): ServicePlanIdentity {
  return {
    label: SCHEDULER_SERVICE_LABEL,
    plistPath: paths.launchAgentPath,
    logPath: paths.logPath,
    windowsTaskName: WINDOWS_SCHEDULER_TASK_NAME,
    programArguments: [
      invocation.command,
      ...invocation.execArgv,
      invocation.cliEntrypoint,
      "schedule",
      "daemon",
      "--foreground",
    ],
  };
}

export function createSchedulerServiceController(options: {
  readonly dataDir: string;
  readonly invocation?: BundledRollInvocation;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}): CompanionServiceController {
  const paths = createSchedulerPaths(options.dataDir, options.homeDir);
  const invocation = options.invocation ?? createBundledRollInvocation();
  return createPlatformServiceController({
    identity: schedulerServiceIdentity(paths, invocation),
    ...(options.platform ? { platform: options.platform } : {}),
  });
}
