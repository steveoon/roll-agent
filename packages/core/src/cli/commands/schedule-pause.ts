import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, openScheduleStore, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "暂停定时任务（保留相位，resume 后按原计划继续）" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        if (!store.setScheduleStatus(args.id, runtime.SCHEDULE_STATUSES.paused)) {
          throw new Error(`定时任务 ${args.id} 不存在；用 roll schedule list 查看`);
        }
        log.success(`已暂停定时任务 ${args.id}`);
      } finally {
        store.close();
      }
    });
  },
});
