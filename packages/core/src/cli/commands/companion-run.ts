import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import {
  createCompanionCliApplication,
  createProcessAbortController,
  runCompanionCommand,
} from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "在前台运行 Companion Host（服务管理器使用的正式入口）" },
  args: {
    foreground: {
      type: "boolean",
      description: "明确以前台模式运行",
      default: false,
    },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      if (args.foreground !== true) {
        throw new Error("Use `roll companion run --foreground`");
      }
      const processSignal = createProcessAbortController();
      log.info("Roll Companion 正以前台模式运行。");
      try {
        await createCompanionCliApplication().runForeground(processSignal.controller.signal);
      } finally {
        processSignal.release();
      }
    });
  },
});
