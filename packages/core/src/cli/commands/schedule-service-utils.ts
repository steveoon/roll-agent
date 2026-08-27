import type { CompanionServiceController } from "../../companion-host/service.ts";
import { readDaemonRecord, removeDaemonRecord } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import {
  createSchedulerServiceController,
  rollbackInstallingWindowsSchedulerService,
  uninstallWindowsSchedulerService,
} from "../../scheduler-host/service.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
  describeSchedulerServiceStateProblem,
  removeSchedulerServiceState,
  windowsSchedulerServiceRecoveryHint,
  type SchedulerServiceState,
  type SchedulerServiceStateInspection,
} from "../../scheduler-host/service-state.ts";
import { loadRuntime, openScheduleStore } from "./schedule-command-utils.ts";

export async function retireWindowsSchedulerService(
  state: SchedulerServiceState,
  statePath: string,
): Promise<void> {
  const paths = createSchedulerPaths(state.dataDir);
  const options = {
    controller: createSchedulerServiceController(state),
    dataDir: paths.dataDir,
    openStore: async () => {
      const runtime = await loadRuntime();
      const store = openScheduleStore(undefined, runtime, {
        dataDir: paths.dataDir,
        requireExistingDatabase: true,
      });
      return { store, close: () => store.close() };
    },
    onUninstalled: () => {
      const record = readDaemonRecord(paths.daemonRecordPath);
      if (record !== undefined) {
        removeDaemonRecord(paths.daemonRecordPath, record);
      }
      removeSchedulerServiceState(statePath, state);
    },
  };
  if (state.phase === SCHEDULER_SERVICE_STATE_PHASES.installing) {
    await rollbackInstallingWindowsSchedulerService(options);
    return;
  }
  await uninstallWindowsSchedulerService(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function quiesceUnprovenWindowsTask(
  controller: CompanionServiceController,
  inspection: SchedulerServiceStateInspection,
  statePath: string,
): Promise<never> {
  const problem = describeSchedulerServiceStateProblem(
    inspection,
    windowsSchedulerServiceRecoveryHint(statePath),
  );
  try {
    if (controller.disable !== undefined) {
      await controller.disable();
      await controller.stop();
    }
  } catch (error) {
    throw new Error(`${problem}；同时 Disable/Stop 该任务失败：${errorMessage(error)}`, {
      cause: error,
    });
  }
  throw new Error(problem);
}
