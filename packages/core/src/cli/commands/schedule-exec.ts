import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { takeScheduleExecEnv } from "../../scheduler-host/exec-env.ts";
import {
  EXECUTE_INVOCATION_KINDS,
  executeInvocation,
} from "../../scheduler-host/execute-invocation.ts";
import { currentExecutorIdentity } from "../../scheduler-host/executor-liveness.ts";
import { createScheduledTurnRunner } from "../../scheduler-host/run-scheduled-turn.ts";
import { log } from "../utils/output.ts";
import {
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
      const execEnv = takeScheduleExecEnv(process.env);
      const runtime = await loadRuntime();
      const store = openScheduleStore(undefined, runtime, { dataDir: execEnv.dataDir });
      try {
        const executor = currentExecutorIdentity();
        if (executor === undefined) {
          store.failInvocation(
            args.invocation,
            execEnv.ownershipToken,
            `无法验证 exec 进程 (PID: ${String(process.pid)}) 的 OS 启动身份，拒绝无人值守执行`,
            Date.now(),
            { terminal: true },
          );
          throw new Error("无法验证 exec 进程的 OS 启动身份");
        }
        const { config } = loadConfig();
        const result = await executeInvocation({
          store,
          invocationId: args.invocation,
          ownershipToken: execEnv.ownershipToken,
          executor,
          runTurn: createScheduledTurnRunner({ config, runtime }),
        });
        printJson(result);
        if (result.kind === EXECUTE_INVOCATION_KINDS.failed) {
          log.warn(`invocation ${args.invocation} 执行失败：${result.error}`);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
  },
});
