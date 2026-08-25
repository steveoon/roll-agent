import { EXECUTOR_LIVENESS } from "@roll-agent/runtime";
import type { ExecutorIdentity } from "@roll-agent/runtime";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  KILL_PROCESS_TREE_OUTCOMES,
  probeExecutorLiveness,
  terminateExecutor,
} from "../../scheduler-host/executor-liveness.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
  serializeInvocation,
} from "./schedule-command-utils.ts";

const KILL_CONFIRM_TIMEOUT_MS = 5_000;
const KILL_CONFIRM_POLL_MS = 100;

const KILL_RESULTS = {
  confirmed: "confirmed",
  treeKillFailed: "tree-kill-failed",
  stillAlive: "still-alive",
  unverifiable: "unverifiable",
} as const;
type KillResult = (typeof KILL_RESULTS)[keyof typeof KILL_RESULTS];

async function killAndConfirmExit(executor: ExecutorIdentity): Promise<KillResult> {
  const outcome = terminateExecutor(executor);
  if (outcome !== KILL_PROCESS_TREE_OUTCOMES.tree) {
    const liveness = probeExecutorLiveness(executor);
    if (liveness === EXECUTOR_LIVENESS.dead) {
      return process.platform === "win32" ? KILL_RESULTS.unverifiable : KILL_RESULTS.confirmed;
    }
    return liveness === EXECUTOR_LIVENESS.unknown
      ? KILL_RESULTS.unverifiable
      : KILL_RESULTS.treeKillFailed;
  }
  const deadline = Date.now() + KILL_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (probeExecutorLiveness(executor) === EXECUTOR_LIVENESS.dead) {
      return KILL_RESULTS.confirmed;
    }
    await new Promise((resolve) => setTimeout(resolve, KILL_CONFIRM_POLL_MS));
  }
  return probeExecutorLiveness(executor) === EXECUTOR_LIVENESS.dead
    ? KILL_RESULTS.confirmed
    : KILL_RESULTS.stillAlive;
}

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
        const before = store.getInvocation(args.invocation);
        if (before === undefined) {
          throw new Error(`invocation ${args.invocation} 不存在`);
        }
        let killed = false;
        if (
          args.kill &&
          before.status === runtime.INVOCATION_STATUSES.running &&
          before.executor !== undefined
        ) {
          const result = await killAndConfirmExit(before.executor);
          if (result === KILL_RESULTS.treeKillFailed) {
            throw new Error(
              `无法整体终止 invocation ${args.invocation} 的 exec 进程树（pid ${String(before.executor.pid)}；Windows 上 taskkill 失败或进程不是进程组首领），未取消、未释放单例`,
            );
          }
          killed = result === KILL_RESULTS.confirmed;
        }
        const outcome = store.cancelInvocation(
          args.invocation,
          args.abandon ? "已由用户放弃追踪（--abandon）" : "已由用户取消",
          Date.now(),
          { abandon: args.abandon },
        );
        const outcomes = runtime.CANCEL_INVOCATION_OUTCOMES;
        if (outcome === outcomes.terminal) {
          throw new Error(`invocation ${args.invocation} 已是终态（${before.status}），无需取消`);
        }
        if (outcome === outcomes.notFound) {
          throw new Error(`invocation ${args.invocation} 不存在`);
        }
        if (outcome === outcomes.executorAlive) {
          throw new Error(
            args.kill
              ? `exec 进程树 (pid ${String(before.executor?.pid ?? "?")}) 在 ${String(KILL_CONFIRM_TIMEOUT_MS)} ms 内未全部退出，未取消；请稍后重试`
              : `invocation ${args.invocation} 的 exec 进程或其进程树仍有存活成员（pid ${String(before.executor?.pid ?? "?")}），取消需要加 --kill`,
          );
        }
        if (outcome === outcomes.executorUnknown) {
          throw new Error(
            `无法确认 invocation ${args.invocation} 的 exec 进程已退出，未取消；确认进程已不存在后可用 --abandon（危险：会释放单例）`,
          );
        }
        const after = store.getInvocation(args.invocation);
        if (after === undefined) {
          throw new Error(`invocation ${args.invocation} 不存在`);
        }
        if (args.json) {
          printJson({ ...serializeInvocation(after), killed, abandoned: args.abandon });
          return;
        }
        log.success(`已取消 invocation ${after.id}（原状态 ${before.status}）`);
        if (killed) {
          log.info(`exec 进程树 (pid ${String(before.executor?.pid ?? "?")}) 已终止并确认退出`);
        }
        if (args.abandon) {
          log.warn("已按 --abandon 释放单例；若旧 exec 进程仍在运行，其副作用不会被阻止");
        }
      } finally {
        store.close();
      }
    });
  },
});
