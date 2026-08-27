import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, openScheduleStore, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "删除定时任务及其运行记录" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
    abandon: {
      type: "boolean",
      description: "危险：即使仍有 running / 未清进程树也删除账本（残留进程不会被停止）",
      default: false,
    },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        if (!store.removeSchedule(args.id, args.abandon ? { abandon: true } : {})) {
          throw new Error(`定时任务 ${args.id} 不存在；用 roll schedule list 查看`);
        }
        log.success(`已删除定时任务 ${args.id}`);
        if (args.abandon) {
          log.warn("已按 --abandon 删除账本；若仍有未清进程，其副作用不会被阻止");
        }
      } finally {
        store.close();
      }
    });
  },
});
