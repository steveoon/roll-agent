import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createSchedulerServiceController } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { printJson, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "查看定时任务 daemon 用户服务的安装与运行状态" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const status = await createSchedulerServiceController({
        dataDir: config.scheduler.dataDir,
      }).status();
      if (args.json) {
        printJson(status);
        return;
      }
      log.info(`installed: ${status.installed ? "是" : "否"}`);
      log.info(`running: ${status.running ? "是" : "否"}`);
    });
  },
});
