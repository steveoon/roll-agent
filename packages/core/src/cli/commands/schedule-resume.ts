import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, openScheduleStore, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "恢复已暂停的定时任务" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        if (!store.setScheduleStatus(args.id, runtime.SCHEDULE_STATUSES.active)) {
          throw new Error(`定时任务 ${args.id} 不存在；用 roll schedule list 查看`);
        }
        log.success(`已恢复定时任务 ${args.id}`);
      } finally {
        store.close();
      }
    });
  },
});
