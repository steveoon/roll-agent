import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "在本机校验并切换唯一 Workspace；云端不能设置 cwd" },
  args: {
    path: {
      type: "positional",
      description: "现有目录的绝对路径",
      required: true,
    },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      const config = await createCompanionCliApplication().setWorkspace(args.path);
      log.success(`Companion Workspace 已切换为 ${config.cwd}`);
    });
  },
});
