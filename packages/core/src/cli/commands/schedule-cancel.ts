import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { cancelScheduledInvocation } from "../../scheduler-host/cancel-invocation.ts";
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
      "取消一次排队中或运行中的 invocation。运行中的必须 --kill 并确认 exec 进程已退出；无法确认时只能用 --abandon（危险）",
  },
  args: {
    invocation: { type: "positional", description: "invocation ID", required: true },
    kill: {
      type: "boolean",
      description:
        "终止仍存活的 exec 进程树（POSIX 进程组 / Windows taskkill /T），确认退出后再取消",
      default: false,
    },
    abandon: {
      type: "boolean",
      description: "危险：不确认 exec 进程已退出就释放单例并置终态，旧进程可能继续产生副作用",
      default: false,
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      if (args.kill && args.abandon) {
        throw new Error("--kill 与 --abandon 互斥：--kill 要求确认进程退出，--abandon 放弃确认");
      }
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        if (args.abandon) {
          const outcomes = runtime.CANCEL_INVOCATION_OUTCOMES;
          const outcome = store.cancelInvocation(
            args.invocation,
            "已由用户放弃追踪（--abandon）",
            Date.now(),
            { abandon: true },
          );
          if (outcome === outcomes.notFound) {
            throw new Error(`invocation ${args.invocation} 不存在`);
          }
          if (outcome === outcomes.terminal) {
            throw new Error(`invocation ${args.invocation} 已是终态，无需取消`);
          }
          if (outcome !== outcomes.cancelled) {
            throw new Error(`invocation ${args.invocation} 无法按 --abandon 取消（${outcome}）`);
          }
          const after = store.getInvocation(args.invocation);
          if (after === undefined) {
            throw new Error(`invocation ${args.invocation} 不存在`);
          }
          if (args.json) {
            printJson({
              ...serializeInvocation(after),
              killed: false,
              abandoned: true,
              unverifiedDescendants: false,
            });
            return;
          }
          log.success(`已按 --abandon 取消 invocation ${after.id}`);
          log.warn("已释放单例；若旧 exec 进程仍在运行，其副作用不会被阻止");
          return;
        }
        const result = await cancelScheduledInvocation({
          store,
          invocationId: args.invocation,
          kill: args.kill,
        });
        if (args.json) {
          printJson({
            ...serializeInvocation(result.invocation),
            killed: result.killed,
            abandoned: false,
            unverifiedDescendants: result.unverifiedDescendants,
          });
          return;
        }
        log.success(`已取消 invocation ${result.invocation.id}（原状态 ${result.previousStatus}）`);
        if (result.killed) {
          log.info(
            `exec 进程树 (pid ${String(result.previousExecutorPid ?? "?")}) 已终止并确认退出`,
          );
        }
        if (result.unverifiedDescendants) {
          log.warn(
            "Windows 无法验证 exec 后代进程是否退出；已按根进程退出取消，若有残留子进程请手动检查",
          );
        }
      } finally {
        store.close();
      }
    });
  },
});
