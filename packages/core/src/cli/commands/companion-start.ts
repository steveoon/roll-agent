import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "启动已安装的当前用户 Companion 服务" },
  async run() {
    await runCompanionCommand(async () => {
      await createCompanionCliApplication().start();
      log.success("Roll Companion 服务已启动。");
    });
  },
});
