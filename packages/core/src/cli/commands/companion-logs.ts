import { defineCommand } from "citty";
import {
  createCompanionCliApplication,
  createProcessAbortController,
  runCompanionCommand,
} from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "读取 Companion Host 日志（不包含 pairing code 或 device credential）" },
  args: {
    follow: { type: "boolean", description: "持续输出新增日志", default: false },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      const app = createCompanionCliApplication();
      const existing = await app.readLogs();
      if (existing.length > 0) {
        process.stdout.write(existing);
      }
      if (args.follow !== true) {
        return;
      }
      const processSignal = createProcessAbortController();
      try {
        await app.followLogs((text) => process.stdout.write(text), processSignal.controller.signal);
      } finally {
        processSignal.release();
      }
    });
  },
});
