import { mkdirSync } from "node:fs";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import {
  SCHEDULER_SERVICE_INSTALL_ACTIONS,
  planSchedulerServiceInstall,
  type SchedulerServiceInstallAction,
} from "../../scheduler-host/service-plan.ts";
import {
  SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
  inspectSchedulerServiceState,
  installSchedulerServiceWithState,
  removeInvalidSchedulerServiceState,
  removeSchedulerServiceState,
  requireSchedulerServiceState,
  schedulerServiceStatePath,
} from "../../scheduler-host/service-state.ts";
import {
  createSchedulerServiceController,
  installSchedulerServiceControllerSafely,
  withSchedulerServiceManagementLock,
  type SchedulerServiceInstallSettings,
} from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";
import {
  quiesceUnprovenWindowsTask,
  retireWindowsSchedulerService,
} from "./schedule-service-utils.ts";

export default defineCommand({
  meta: {
    description: "安装并启动定时任务 daemon 的 per-user LaunchAgent 或当前用户 Scheduled Task",
  },
  async run() {
    await runScheduleCommand(async () => {
      try {
        await import("node:sqlite");
      } catch {
        throw new Error(
          "当前 Node 进程无法加载 node:sqlite（Node < 22.13 需要 --experimental-sqlite）；请通过 roll 命令安装，或升级 Node",
        );
      }
      const { config } = loadConfig();
      const refreshed = await withSchedulerServiceManagementLock(async () => {
        const nextPaths = createSchedulerPaths(config.scheduler.dataDir);
        const next: SchedulerServiceInstallSettings = {
          dataDir: nextPaths.dataDir,
          maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
        };
        const statePath = schedulerServiceStatePath();
        const inspection = inspectSchedulerServiceState(statePath);
        const controller = createSchedulerServiceController(
          inspection.status === "valid" ? inspection.state : next,
        );
        const action = planSchedulerServiceInstall({
          platform: process.platform,
          inspection,
          next,
          status: await controller.status(),
        });
        mkdirSync(nextPaths.dataDir, { recursive: true, mode: 0o700 });
        const installFresh = async (): Promise<void> => {
          await installSchedulerServiceWithState(
            statePath,
            { schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION, ...next },
            async () =>
              installSchedulerServiceControllerSafely(createSchedulerServiceController(next)),
          );
        };
        const handlers: Record<SchedulerServiceInstallAction, () => Promise<boolean>> = {
          [SCHEDULER_SERVICE_INSTALL_ACTIONS.refresh]: async () => {
            await controller.install();
            return true;
          },
          [SCHEDULER_SERVICE_INSTALL_ACTIONS.retire]: async () => {
            await retireWindowsSchedulerService(
              requireSchedulerServiceState(inspection),
              statePath,
            );
            await installFresh();
            return false;
          },
          [SCHEDULER_SERVICE_INSTALL_ACTIONS.replace]: async () => {
            await controller.uninstall();
            removeSchedulerServiceState(statePath, requireSchedulerServiceState(inspection));
            await installFresh();
            return false;
          },
          [SCHEDULER_SERVICE_INSTALL_ACTIONS.adopt]: async () => {
            await controller.uninstall();
            removeInvalidSchedulerServiceState(statePath);
            await installFresh();
            return false;
          },
          [SCHEDULER_SERVICE_INSTALL_ACTIONS.failClosed]: () =>
            quiesceUnprovenWindowsTask(controller, inspection, statePath),
          [SCHEDULER_SERVICE_INSTALL_ACTIONS.install]: async () => {
            await installFresh();
            return false;
          },
        };
        return handlers[action]();
      });
      log.success(
        refreshed
          ? "roll schedule daemon 用户服务定义已刷新（正在运行的 daemon 不会重启）。"
          : "roll schedule daemon 用户服务已安装并启动。",
      );
    });
  },
});
