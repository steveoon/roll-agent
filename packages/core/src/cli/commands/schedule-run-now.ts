import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import { inspectDaemon, DAEMON_LIVENESS } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { createInvocationSpawner } from "../../scheduler-host/spawn-invocation.ts";
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
          throw new Error(
            `invocation ${queued.id} 已被 daemon 接管，请用 roll schedule runs ${args.id} 查看`,
          );
        }
        const handle = createInvocationSpawner({
          invocation: createBundledRollInvocation(),
          dataDir: paths.dataDir,
          logPath: paths.logPath,
        })(claim);
        const renew = setInterval(() => {
          store.renewLease(claim.invocation.id, claim.ownershipToken);
        }, runtime.SCHEDULER_LIMITS.leaseRenewIntervalMs);
        let code: number | null;
        try {
          code = await handle.exited;
        } finally {
          clearInterval(renew);
        }
        store.failInvocation(
          claim.invocation.id,
          claim.ownershipToken,
          `exec 进程退出 code=${code === null ? "null" : String(code)}，未写入执行结果`,
        );
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
