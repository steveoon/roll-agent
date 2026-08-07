import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "启用 Companion；已安装的用户服务会同步启动" },
  async run() {
    await runCompanionCommand(async () => {
      await createCompanionCliApplication().enable();
      log.success("Roll Companion 已启用。");
    });
  },
});
