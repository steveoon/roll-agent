import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "停止 Companion 并删除本机设备绑定和 OS 凭据" },
  async run() {
    await runCompanionCommand(async () => {
      const removed = await createCompanionCliApplication().unenroll();
      log.success(removed ? "Roll Companion 已解除绑定。" : "Roll Companion 尚未绑定。");
    });
  },
});
