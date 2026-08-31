import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import { inspectDaemon, DAEMON_LIVENESS } from "../../scheduler-host/daemon-record.ts";
import {
  INLINE_EXIT_DECISIONS,
  armInlineRunTimeout,
  createInlineStopForwarder,
  inlineProcessExitCode,
  settleInlineAfterExit,
  waitForInlineRootExit,
  type InlineExitDecision,
} from "../../scheduler-host/inline-exit.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { createInvocationSpawner } from "../../scheduler-host/spawn-invocation.ts";
import { tryWithSchedulerAdmissionLock } from "../../scheduler-host/scheduler-admission.ts";
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

export default defineCommand({
  meta: {
    description:
      "立即手动触发一次定时任务（默认入队交给 daemon；--inline 在当前进程内单次执行并等待结果）",
  },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
    inline: {
      type: "boolean",
      description: "在当前进程内执行并等待结果（只尝试一次，受任务 --max-run 限制，不依赖 daemon）",
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
        const admission = tryWithSchedulerAdmissionLock(paths.dataDir, () =>
          store.claimPendingInvocation(queued.id, `inline-${String(process.pid)}`),
        );
        if (!admission.acquired) {
          if (store.discardPendingInvocation(queued.id)) {
            throw new Error("scheduler service 正在维护，未启动 inline invocation；请稍后重试");
          }
          throw new Error(
            `invocation ${queued.id} 已被 daemon 接管，请用 roll schedule runs ${args.id} 查看`,
          );
        }
        const claim = admission.value;
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
        const maxRunMs = claim.schedule.maxRunMs ?? runtime.SCHEDULER_LIMITS.maxRunMs;
        let timeoutError: string | undefined;
        let timedOutAtMs: number | undefined;
        const clearRunTimeout = armInlineRunTimeout(maxRunMs, () => {
          timedOutAtMs = Date.now();
          timeoutError = `invocation ${claim.invocation.id} 运行超过 ${String(maxRunMs)} ms`;
          log.warn(`${timeoutError}，请求 exec 停止并清理进程树`);
          forwarder.forward();
        });
        const stop = installStopSignals(forwarder.forward, forwarder.escalate);
        const renew = setInterval(() => {
          store.renewLease(claim.invocation.id, claim.ownershipToken);
        }, runtime.SCHEDULER_LIMITS.leaseRenewIntervalMs);
        let decision: InlineExitDecision | undefined;
        try {
          try {
            const code = await waitForInlineRootExit(handle.exited, forwarder);
            clearRunTimeout();
            decision = await settleInlineAfterExit({
              store,
              forwarder,
              invocationId: claim.invocation.id,
              ownershipToken: claim.ownershipToken,
              expectedAttempt: claim.invocation.attempt,
              exitCode: code,
              ...(timeoutError === undefined || timedOutAtMs === undefined
                ? {}
                : { timeoutError, timedOutAtMs }),
            });
          } catch (error) {
            forwarder.seal();
            throw error;
          } finally {
            clearInterval(renew);
            clearRunTimeout();
          }
        } finally {
          stop.release();
        }
        const final = store.getInvocation(queued.id);
        if (final === undefined) {
          throw new Error(`invocation ${queued.id} 不存在`);
        }
        if (
          decision !== undefined &&
          decision !== INLINE_EXIT_DECISIONS.fail &&
          final.status === runtime.INVOCATION_STATUSES.running
        ) {
          log.warn(
            decision === INLINE_EXIT_DECISIONS.holdUnconfirmedKill
              ? "exec 根进程已退出，但对其进程树的终止未被确认；保留 running，不释放单例（可用 roll schedule cancel --kill 收尾）"
              : "exec 根进程已退出，但其进程树仍有存活成员或无法探活；保留 running，不释放单例（可用 roll schedule cancel --kill 收尾）",
          );
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
        const exitCode = inlineProcessExitCode(final.status);
        if (exitCode === 1) {
          process.exitCode = exitCode;
        }
      } finally {
        store.close();
      }
    });
  },
});
