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
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const rows = store.listSchedules().map(serializeSchedule);
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
