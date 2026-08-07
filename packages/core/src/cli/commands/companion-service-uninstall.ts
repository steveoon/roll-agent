import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "优雅停止并卸载当前用户的 Companion 服务" },
  async run() {
    await runCompanionCommand(async () => {
      await createCompanionCliApplication().uninstallService();
      log.success("Roll Companion 用户服务已卸载。");
    });
  },
});
