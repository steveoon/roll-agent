import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createSchedulerServiceController } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "停止并卸载定时任务 daemon 的用户服务" },
  async run() {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      await createSchedulerServiceController({ dataDir: config.scheduler.dataDir }).uninstall();
      log.success("roll schedule daemon 用户服务已卸载。");
    });
  },
});
