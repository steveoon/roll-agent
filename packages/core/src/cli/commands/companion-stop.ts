import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "先停止 Relay，再优雅关闭 Runtime 和 Companion 服务" },
  async run() {
    await runCompanionCommand(async () => {
      await createCompanionCliApplication().stop();
      log.success("Roll Companion 服务已停止。");
    });
  },
});
