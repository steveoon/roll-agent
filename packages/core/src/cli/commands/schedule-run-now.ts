import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import { inspectDaemon, DAEMON_LIVENESS } from "../../scheduler-host/daemon-record.ts";
import {
  INLINE_EXIT_DECISIONS,
  createInlineStopForwarder,
  settleInlineInvocation,
} from "../../scheduler-host/inline-exit.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { createInvocationSpawner } from "../../scheduler-host/spawn-invocation.ts";
import { installStopSignals } from "../../scheduler-host/stop-signals.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  requireSchedule,
  runScheduleCommand,
  serializeInvocation,
} from "./schedule-command-utils.ts";

const INLINE_SUCCESS_STATUSES: ReadonlySet<string> = new Set(["completed", "needs_confirmation"]);

export default defineCommand({
  meta: {
    description:
      "立即手动触发一次定时任务（默认入队交给 daemon；--inline 在当前进程内单次执行并等待结果）",
  },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
    inline: {
      type: "boolean",
      description: "在当前进程内执行并等待结果（只尝试一次，不依赖 daemon）",
      default: false,
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const paths = createSchedulerPaths(config.scheduler.dataDir);
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        requireSchedule(store, args.id);
        if (!args.inline) {
          const queued = store.enqueueManualInvocation(args.id);
          if (inspectDaemon(paths.daemonRecordPath).liveness !== DAEMON_LIVENESS.running) {
            log.warn("daemon 未运行，该次触发会等到 daemon 启动后才执行；或改用 --inline。");
          }
          if (args.json) {
            printJson(serializeInvocation(queued));
          } else {
            log.success(`已入队 invocation ${queued.id}`);
          }
          return;
        }
        const queued = store.enqueueManualInvocation(args.id, Date.now(), { maxAttempts: 1 });
        const claim = store.claimPendingInvocation(queued.id, `inline-${String(process.pid)}`);
        if (claim === undefined) {
          const live = store.findLiveRun(args.id);
          if (store.discardPendingInvocation(queued.id) && live !== undefined) {
            throw new Error(
              `任务正在运行中（invocation ${live.id}，${live.status}），同一任务同一时刻只运行一次；请等待完成，或不加 --inline 入队等待`,
            );
          }
          throw new Error(
            `invocation ${queued.id} 已被 daemon 接管，请用 roll schedule runs ${args.id} 查看`,
          );
        }
        const handle = createInvocationSpawner({
          invocation: createBundledRollInvocation(),
          dataDir: paths.dataDir,
          logPath: paths.logPath,
        })(claim);
        const forwarder = createInlineStopForwarder(handle);
        const stop = installStopSignals(forwarder.forward, forwarder.escalate);
        const renew = setInterval(() => {
          store.renewLease(claim.invocation.id, claim.ownershipToken);
        }, runtime.SCHEDULER_LIMITS.leaseRenewIntervalMs);
        let decision;
        try {
          let code: number | null;
          try {
            code = await handle.exited;
          } finally {
            clearInterval(renew);
            forwarder.seal();
          }
          decision = settleInlineInvocation({
            store,
            invocationId: claim.invocation.id,
            ownershipToken: claim.ownershipToken,
            killOutcome: forwarder.killOutcome(),
            exitCode: code,
          });
        } finally {
          stop.release();
        }
        if (decision !== INLINE_EXIT_DECISIONS.fail) {
          log.warn(
            decision === INLINE_EXIT_DECISIONS.holdUnconfirmedKill
              ? "exec 根进程已退出，但对其进程树的终止未被确认；保留 running，不释放单例（可用 roll schedule cancel --kill 收尾）"
              : "exec 根进程已退出，但其进程树仍有存活成员或无法探活；保留 running，不释放单例（可用 roll schedule cancel --kill 收尾）",
          );
        }
        const final = store.getInvocation(queued.id);
        if (final === undefined) {
          throw new Error(`invocation ${queued.id} 不存在`);
        }
        if (args.json) {
          printJson(serializeInvocation(final));
        } else {
          log.info(
            `invocation ${final.id}: ${final.status}${final.threadId ? ` thread=${final.threadId}` : ""}${final.error ? ` error=${final.error}` : ""}`,
          );
        }
        if (final.status === runtime.INVOCATION_STATUSES.needsConfirmation) {
          log.warn("本次执行有工具调用因无人值守被拒绝，详见 pendingActions。");
        }
        if (!INLINE_SUCCESS_STATUSES.has(final.status)) {
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
  },
});
