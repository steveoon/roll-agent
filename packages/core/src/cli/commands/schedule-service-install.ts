import { mkdirSync } from "node:fs";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createSchedulerServiceController } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: {
    description: "安装并启动定时任务 daemon 的 per-user LaunchAgent 或当前用户 Scheduled Task",
  },
  async run() {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      mkdirSync(config.scheduler.dataDir, { recursive: true, mode: 0o700 });
      await createSchedulerServiceController({ dataDir: config.scheduler.dataDir }).install();
      log.success("roll schedule daemon 用户服务已安装并启动。");
    });
  },
});
