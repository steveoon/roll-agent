import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { withSchedulerServiceManagementLock } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";
import {
  assertNodeSqliteAvailable,
  installSchedulerServiceUnlocked,
} from "./schedule-service-utils.ts";

export default defineCommand({
  meta: {
    description: "安装并启动定时任务 daemon 的 per-user LaunchAgent 或当前用户 Scheduled Task",
  },
  async run() {
    await runScheduleCommand(async () => {
      await assertNodeSqliteAvailable();
      const { config } = loadConfig();
      const refreshed = await withSchedulerServiceManagementLock(() =>
        installSchedulerServiceUnlocked(config),
      );
      log.success(
        refreshed
          ? "roll schedule daemon 用户服务定义已刷新（正在运行的 daemon 不会重启）。"
          : "roll schedule daemon 用户服务已安装并启动。",
      );
    });
  },
});
