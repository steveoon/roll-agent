import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  requireSchedule,
  runScheduleCommand,
  serializeSchedule,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "查看一个定时任务的详情" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const record = serializeSchedule(requireSchedule(store, args.id));
        if (args.json) {
          printJson(record);
          return;
        }
        for (const [key, value] of Object.entries(record)) {
          console.log(`${key}: ${value === undefined ? "-" : String(value)}`);
        }
      } finally {
        store.close();
      }
    });
  },
});
