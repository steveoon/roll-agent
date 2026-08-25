import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { executeInvocation } from "../../scheduler-host/execute-invocation.ts";
import { createScheduledTurnRunner } from "../../scheduler-host/run-scheduled-turn.ts";
import { log } from "../utils/output.ts";
import {
  SCHEDULE_TOKEN_ENV,
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "（daemon 内部入口）执行一条已 claim 的定时任务 invocation" },
  args: {
    invocation: { type: "string", description: "invocation ID", required: true },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const ownershipToken = process.env[SCHEDULE_TOKEN_ENV];
      if (ownershipToken === undefined || ownershipToken.length === 0) {
        throw new Error(`缺少 ${SCHEDULE_TOKEN_ENV}；该命令只应由 roll schedule daemon 调用`);
      }
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const result = await executeInvocation({
          store,
          invocationId: args.invocation,
          ownershipToken,
          runTurn: createScheduledTurnRunner({ config, runtime }),
        });
        printJson(result);
        if (result.kind === "failed") {
          log.warn(`invocation ${args.invocation} 执行失败：${result.error}`);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
  },
});
