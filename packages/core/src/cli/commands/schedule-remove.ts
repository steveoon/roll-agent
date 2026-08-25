import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, openScheduleStore, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "删除定时任务及其运行记录" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        if (!store.removeSchedule(args.id)) {
          throw new Error(`定时任务 ${args.id} 不存在；用 roll schedule list 查看`);
        }
        log.success(`已删除定时任务 ${args.id}`);
      } finally {
        store.close();
      }
    });
  },
});
