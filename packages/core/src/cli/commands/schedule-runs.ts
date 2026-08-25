import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  requireSchedule,
  runScheduleCommand,
  serializeInvocation,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "查看定时任务的历次运行记录" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
    limit: { type: "string", description: "最多显示的记录数", default: "20" },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const limit = Number.parseInt(args.limit, 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`--limit 必须是正整数（收到 ${args.limit}）`);
      }
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        requireSchedule(store, args.id);
        const rows = store.listInvocations(args.id, limit).map(serializeInvocation);
        if (args.json) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log("暂无运行记录。");
          return;
        }
        for (const row of rows) {
          console.log(
            `${row.status.padEnd(19)} ${row.scheduledFor}  attempt=${String(row.attempt)}  thread=${row.threadId ?? "-"}${row.error ? `  ${row.error}` : ""}`,
          );
        }
      } finally {
        store.close();
      }
    });
  },
});
