import { defineCommand } from "citty";
import {
  SCHEDULER_SERVICE_UNINSTALL_ACTIONS,
  planSchedulerServiceUninstall,
  type SchedulerServiceUninstallAction,
} from "../../scheduler-host/service-plan.ts";
import {
  inspectSchedulerServiceState,
  removeInvalidSchedulerServiceState,
  removeSchedulerServiceState,
  requireSchedulerServiceState,
  schedulerServiceStatePath,
} from "../../scheduler-host/service-state.ts";
import {
  createSchedulerServiceController,
  defaultSchedulerServiceSettings,
  withSchedulerServiceManagementLock,
} from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";
import {
  quiesceUnprovenWindowsTask,
  retireWindowsSchedulerService,
} from "./schedule-service-utils.ts";

export default defineCommand({
  meta: { description: "停止并卸载定时任务 daemon 的用户服务" },
  async run() {
    await runScheduleCommand(async () => {
      const uninstalled = await withSchedulerServiceManagementLock(async () => {
        const statePath = schedulerServiceStatePath();
        const inspection = inspectSchedulerServiceState(statePath);
        const fallbackController = createSchedulerServiceController(
          defaultSchedulerServiceSettings(),
        );
        const taskInstalled =
          inspection.status !== "valid" ? (await fallbackController.status()).installed : false;
        const action = planSchedulerServiceUninstall({
          platform: process.platform,
          inspection,
          taskInstalled,
        });
        const handlers: Record<SchedulerServiceUninstallAction, () => Promise<boolean>> = {
          [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.retire]: async () => {
            await retireWindowsSchedulerService(
              requireSchedulerServiceState(inspection),
              statePath,
            );
            return true;
          },
          [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByMetadata]: async () => {
            const state = requireSchedulerServiceState(inspection);
            await createSchedulerServiceController(state).uninstall();
            removeSchedulerServiceState(statePath, state);
            return true;
          },
          [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.uninstallByDefaults]: async () => {
            await fallbackController.uninstall();
            removeInvalidSchedulerServiceState(statePath);
            return true;
          },
          [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.failClosed]: () =>
            quiesceUnprovenWindowsTask(fallbackController, inspection, statePath),
          [SCHEDULER_SERVICE_UNINSTALL_ACTIONS.nothingInstalled]: async () => {
            if (removeInvalidSchedulerServiceState(statePath)) {
              log.warn("已清除无效的 scheduler service metadata（未发现已安装的 Scheduled Task）");
            }
            return false;
          },
        };
        return handlers[action]();
      });
      log.success(
        uninstalled
          ? "roll schedule daemon 用户服务已卸载。"
          : "未发现已安装的 roll schedule daemon 用户服务。",
      );
    });
  },
});
