import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "安装并启动 per-user LaunchAgent 或当前用户 Scheduled Task" },
  async run() {
    await runCompanionCommand(async () => {
      await createCompanionCliApplication().installService();
      log.success("Roll Companion 用户服务已安装并启动。");
    });
  },
});
