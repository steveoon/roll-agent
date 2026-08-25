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
      try {
        await import("node:sqlite");
      } catch {
        throw new Error(
          "当前 Node 进程无法加载 node:sqlite（Node < 22.13 需要 --experimental-sqlite）；请通过 roll 命令安装，或升级 Node",
        );
      }
      const { config } = loadConfig();
      mkdirSync(config.scheduler.dataDir, { recursive: true, mode: 0o700 });
      await createSchedulerServiceController({
        dataDir: config.scheduler.dataDir,
        maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
      }).install();
      log.success("roll schedule daemon 用户服务已安装并启动。");
    });
  },
});
