import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  formatScheduleLine,
  liveRunHint,
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
  serializeSchedule,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "列出所有定时任务" },
  args: {
    status: {
      type: "string",
      description: "按状态过滤：all、active、paused、completed",
      default: "all",
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        if (
          args.status !== "all" &&
          !Object.values(runtime.SCHEDULE_STATUSES).some((status) => status === args.status)
        ) {
          throw new Error("status 必须是 all、active、paused 或 completed");
        }
        const rows = store
          .listSchedules()
          .filter((record) => args.status === "all" || record.status === args.status)
          .map(serializeSchedule);
        if (args.json) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(
            "暂无定时任务。用 `roll schedule add <prompt> --name <name> --every 30m` 登记一个。",
          );
          return;
        }
        for (const row of rows) {
          console.log(formatScheduleLine(row, liveRunHint(store, row.id)));
        }
      } finally {
        store.close();
      }
    });
  },
});
