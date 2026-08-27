import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { takeScheduleExecEnv } from "../../scheduler-host/exec-env.ts";
import {
  EXECUTE_INVOCATION_KINDS,
  INVOCATION_TREE_TEARDOWN_PHASES,
  executeInvocation,
  type InvocationTreeTeardownPhase,
} from "../../scheduler-host/execute-invocation.ts";
import { readExecutorIdentityWithRetry } from "../../scheduler-host/executor-liveness.ts";
import {
  INVOCATION_TREE_TEARDOWN_OUTCOMES,
  ProcessGroupLedger,
  terminateInvocationTree,
  type InvocationTreeTeardown,
} from "../../scheduler-host/invocation-tree.ts";
import { createScheduledTurnRunner } from "../../scheduler-host/run-scheduled-turn.ts";
import { installStopSignals } from "../../scheduler-host/stop-signals.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
} from "./schedule-command-utils.ts";

const PHASE_LABELS = {
  [INVOCATION_TREE_TEARDOWN_PHASES.preflight]: "运行前",
  [INVOCATION_TREE_TEARDOWN_PHASES.settle]: "运行结束时",
} as const satisfies Record<InvocationTreeTeardownPhase, string>;

function reportTeardown(
  invocationId: string,
  phase: InvocationTreeTeardownPhase,
  report: InvocationTreeTeardown,
): void {
  if (report.terminatedPids.length > 0) {
    log.warn(
      `invocation ${invocationId} ${PHASE_LABELS[phase]}终止了 ${String(report.terminatedPids.length)} 个残留进程：pid ${report.terminatedPids.map(String).join(", ")}`,
    );
  }
  if (report.skippedReusedGroups.length > 0) {
    log.warn(
      `invocation ${invocationId} 登记的进程组 ${report.skippedReusedGroups.map(String).join(", ")} 首领 PID 已被复用，跳过`,
    );
  }
  if (report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable) {
    log.error(
      `invocation ${invocationId} ${PHASE_LABELS[phase]}无法枚举进程树${report.error === undefined ? "" : `：${report.error}`}`,
    );
  }
}

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
      const stop = installStopSignals(
        (signal) => {
          log.warn(`收到 ${signal}，正在取消 scheduled turn 并清理工具进程…`);
          return new Error(`schedule exec received ${signal}`);
        },
        (signal) => log.warn(`再次收到 ${signal}，等待父进程在 grace 后强制终止`),
      );
      try {
        const executor = readExecutorIdentityWithRetry();
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
        const previousExecutorPid = store.getInvocation(args.invocation)?.executor?.pid;
        const ledger = new ProcessGroupLedger();
        const { config } = loadConfig();
        const result = await executeInvocation({
          store,
          invocationId: args.invocation,
          ownershipToken: execEnv.ownershipToken,
          executor,
          runTurn: createScheduledTurnRunner({
            config,
            runtime,
            stopSignal: stop.controller.signal,
            onShellCommandSpawn: (child) => ledger.track(child),
          }),
          stopSignal: stop.controller.signal,
          teardownTree: () =>
            terminateInvocationTree({
              invocationId: args.invocation,
              selfPid: process.pid,
              trackedGroups: ledger.groups(),
              ...(previousExecutorPid !== undefined ? { previousExecutorPid } : {}),
            }),
          onTeardown: (phase, report) => reportTeardown(args.invocation, phase, report),
        });
        printJson(result);
        if (result.kind === EXECUTE_INVOCATION_KINDS.failed) {
          log.warn(`invocation ${args.invocation} 执行失败：${result.error}`);
          process.exitCode = 1;
        }
        if (result.kind === EXECUTE_INVOCATION_KINDS.interrupted) {
          log.warn(
            `invocation ${args.invocation} 被停止信号中断，未写入结果，交由发起方收尾：${result.error}`,
          );
          process.exitCode = 1;
        }
        if (result.kind === EXECUTE_INVOCATION_KINDS.unsettled) {
          log.error(
            `invocation ${args.invocation} 的进程树未能清理干净，未写入结果，行保持 running：${result.error}`,
          );
          process.exitCode = 1;
        }
      } finally {
        stop.release();
        store.close();
      }
    });
  },
});
