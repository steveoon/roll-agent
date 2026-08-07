import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "优雅重启已安装的 Companion 服务" },
  async run() {
    await runCompanionCommand(async () => {
      await createCompanionCliApplication().restart();
      log.success("Roll Companion 服务已重启。");
    });
  },
});
