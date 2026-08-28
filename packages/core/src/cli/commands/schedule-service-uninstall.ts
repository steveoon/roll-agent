import { defineCommand } from "citty";
import { withSchedulerServiceManagementLock } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";
import { uninstallSchedulerServiceUnlocked } from "./schedule-service-utils.ts";

export default defineCommand({
  meta: { description: "停止并卸载定时任务 daemon 的用户服务" },
  async run() {
    await runScheduleCommand(async () => {
      const uninstalled = await withSchedulerServiceManagementLock(() =>
        uninstallSchedulerServiceUnlocked(),
      );
      log.success(
        uninstalled
          ? "roll schedule daemon 用户服务已卸载。"
          : "未发现已安装的 roll schedule daemon 用户服务。",
      );
    });
  },
});
