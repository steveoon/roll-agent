import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { terminateExecutor } from "../../scheduler-host/executor-liveness.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
  serializeInvocation,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: {
    description:
      "取消一次排队中或运行中的 invocation（写入终态并作废其 token；--kill 同时终止 exec 进程）",
  },
  args: {
    invocation: { type: "positional", description: "invocation ID", required: true },
    kill: {
      type: "boolean",
      description: "若 exec 进程仍可验证存活，向其进程组发送 SIGKILL",
      default: false,
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const before = store.getInvocation(args.invocation);
        if (before === undefined) {
          throw new Error(`invocation ${args.invocation} 不存在`);
        }
        if (!store.cancelInvocation(args.invocation, "已由用户取消")) {
          throw new Error(`invocation ${args.invocation} 已是终态（${before.status}），无需取消`);
        }
        let killed = false;
        if (args.kill && before.executor !== undefined) {
          killed = terminateExecutor(before.executor);
        }
        const after = store.getInvocation(args.invocation);
        if (after === undefined) {
          throw new Error(`invocation ${args.invocation} 不存在`);
        }
        if (args.json) {
          printJson({ ...serializeInvocation(after), killed });
          return;
        }
        log.success(`已取消 invocation ${after.id}（原状态 ${before.status}）`);
        if (before.executor !== undefined) {
          log.info(
            args.kill
              ? killed
                ? `已向 exec 进程组 (pid ${String(before.executor.pid)}) 发送 SIGKILL`
                : `exec 进程 (pid ${String(before.executor.pid)}) 不再存活或身份无法确认，未发送信号`
              : `exec 进程 (pid ${String(before.executor.pid)}) 未被终止；其后续写入会因 token 作废而被忽略，需要时加 --kill`,
          );
        }
      } finally {
        store.close();
      }
    });
  },
});
