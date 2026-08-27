import type { CompanionServiceStatus } from "../companion-host/service.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
  type SchedulerServiceStateInspection,
} from "./service-state.ts";
import type { SchedulerServiceInstallSettings } from "./service.ts";

export const SCHEDULER_SERVICE_INSTALL_ACTIONS = {
  refresh: "refresh",
  retire: "retire",
  replace: "replace",
  adopt: "adopt",
  failClosed: "fail-closed",
  install: "install",
} as const;
export type SchedulerServiceInstallAction =
  (typeof SCHEDULER_SERVICE_INSTALL_ACTIONS)[keyof typeof SCHEDULER_SERVICE_INSTALL_ACTIONS];

export function planSchedulerServiceInstall(input: {
  readonly platform: NodeJS.Platform;
  readonly inspection: SchedulerServiceStateInspection;
  readonly next: SchedulerServiceInstallSettings;
  readonly status: CompanionServiceStatus;
}): SchedulerServiceInstallAction {
  const windows = input.platform === "win32";
  if (input.inspection.status === "valid") {
    const previous = input.inspection.state;
    const unchanged =
      previous.phase === SCHEDULER_SERVICE_STATE_PHASES.installed &&
      previous.dataDir === input.next.dataDir &&
      previous.maxConcurrentRuns === input.next.maxConcurrentRuns;
    const quiesced = windows && input.status.installed && input.status.enabled === false;
    if (unchanged && !quiesced) {
      return SCHEDULER_SERVICE_INSTALL_ACTIONS.refresh;
    }
    return windows
      ? SCHEDULER_SERVICE_INSTALL_ACTIONS.retire
      : SCHEDULER_SERVICE_INSTALL_ACTIONS.replace;
  }
  if (!input.status.installed) {
    return SCHEDULER_SERVICE_INSTALL_ACTIONS.install;
  }
  return windows
    ? SCHEDULER_SERVICE_INSTALL_ACTIONS.failClosed
    : SCHEDULER_SERVICE_INSTALL_ACTIONS.adopt;
}

export const SCHEDULER_SERVICE_UNINSTALL_ACTIONS = {
  retire: "retire",
  uninstallByMetadata: "uninstall-by-metadata",
  uninstallByDefaults: "uninstall-by-defaults",
  failClosed: "fail-closed",
  nothingInstalled: "nothing-installed",
} as const;
export type SchedulerServiceUninstallAction =
  (typeof SCHEDULER_SERVICE_UNINSTALL_ACTIONS)[keyof typeof SCHEDULER_SERVICE_UNINSTALL_ACTIONS];

export function planSchedulerServiceUninstall(input: {
  readonly platform: NodeJS.Platform;
  readonly inspection: SchedulerServiceStateInspection;
  readonly taskInstalled: boolean;
}): SchedulerServiceUninstallAction {
  const windows = input.platform === "win32";
  if (input.inspection.status === "valid") {
    return windows
      ? SCHEDULER_SERVICE_UNINSTALL_ACTIONS.retire
      : SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByMetadata;
  }
  if (!input.taskInstalled) {
    return SCHEDULER_SERVICE_UNINSTALL_ACTIONS.nothingInstalled;
  }
  return windows
    ? SCHEDULER_SERVICE_UNINSTALL_ACTIONS.failClosed
    : SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByDefaults;
}
