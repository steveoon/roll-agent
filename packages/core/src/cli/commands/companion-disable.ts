import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "先断开 Relay、关闭 Runtime，再禁用 Companion" },
  async run() {
    await runCompanionCommand(async () => {
      await createCompanionCliApplication().disable();
      log.success("Roll Companion 已禁用。");
    });
  },
});
