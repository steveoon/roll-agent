import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { schedulerConfigSchema } from "../../config/schema.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import { FileCompanionLogger } from "../../companion-host/logger.ts";
import {
  AgentLifecycleBusyError,
  acquireAgentLifecycleLock,
} from "../../registry/process-manager.ts";
import { SchedulerDaemon, stopReasonFor } from "../../scheduler-host/daemon.ts";
import {
  createDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "../../scheduler-host/daemon-record.ts";
import { terminateExecutor } from "../../scheduler-host/executor-liveness.ts";
import { SCHEDULER_DAEMON_LOCK_NAME, createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { createInvocationSpawner } from "../../scheduler-host/spawn-invocation.ts";
import { installStopSignals } from "../../scheduler-host/stop-signals.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, openScheduleStore, runScheduleCommand } from "./schedule-command-utils.ts";

function parseMaxConcurrentRuns(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  const checked = schedulerConfigSchema.shape.maxConcurrentRuns.safeParse(parsed);
  if (!checked.success || String(parsed) !== value.trim()) {
    throw new Error(`--max-concurrent-runs 必须是 1..8 的整数（收到 ${value}）`);
  }
  return checked.data;
}

export default defineCommand({
  meta: { description: "在前台运行定时任务 daemon（服务管理器使用的正式入口）" },
  args: {
    foreground: { type: "boolean", description: "明确以前台模式运行", default: false },
    "data-dir": {
      type: "string",
      description: "调度数据目录（服务安装时固化；缺省按当前目录配置解析）",
    },
    "max-concurrent-runs": {
      type: "string",
      description: "同时运行的任务数上限 1..8（服务安装时固化；缺省按配置解析）",
    },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      if (args.foreground !== true) {
        throw new Error("Use `roll schedule daemon --foreground`");
      }
      const explicitMaxConcurrentRuns = parseMaxConcurrentRuns(args["max-concurrent-runs"]);
      const explicitDataDir =
        args["data-dir"] === undefined ? undefined : resolve(args["data-dir"]);
      const config =
        explicitDataDir !== undefined && explicitMaxConcurrentRuns !== undefined
          ? undefined
          : loadConfig().config;
      const dataDir = explicitDataDir ?? config?.scheduler.dataDir;
      const maxConcurrentRuns = explicitMaxConcurrentRuns ?? config?.scheduler.maxConcurrentRuns;
      if (dataDir === undefined || maxConcurrentRuns === undefined) {
        throw new Error("无法确定 scheduler data-dir / max-concurrent-runs");
      }
      const paths = createSchedulerPaths(dataDir);
      mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
      let lock;
      try {
        lock = acquireAgentLifecycleLock(paths.dataDir, SCHEDULER_DAEMON_LOCK_NAME);
      } catch (error) {
        if (error instanceof AgentLifecycleBusyError) {
          throw new Error("已有 roll schedule daemon 在运行；用 roll schedule status 查看");
        }
        throw error;
      }
      const record = createDaemonRecord(`daemon-${String(process.pid)}`);
      writeDaemonRecord(paths.daemonRecordPath, record);
      const fileLogger = new FileCompanionLogger(paths.logPath);
      const mirrorToStderr = process.stderr.isTTY === true;
      const logger = {
        info: (message: string) => {
          fileLogger.info(message);
          if (mirrorToStderr) {
            log.info(message);
          }
        },
        error: (message: string) => {
          fileLogger.error(message);
          if (mirrorToStderr) {
            log.error(message);
          }
        },
      };
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime, { dataDir: paths.dataDir });
      const daemon = new SchedulerDaemon({
        store,
        workerId: record.workerId,
        maxConcurrentRuns,
        spawnInvocation: createInvocationSpawner({
          invocation: createBundledRollInvocation(),
          dataDir: paths.dataDir,
          logPath: paths.logPath,
        }),
        terminateExecutor,
        logger,
      });
      logger.info(
        `data-dir=${paths.dataDir} max-concurrent-runs=${String(maxConcurrentRuns)}（${config === undefined ? "由启动参数固化" : "由配置解析"}）`,
      );
      const stop = installStopSignals(
        (signal) => {
          const reason = stopReasonFor(signal);
          if (reason !== undefined) {
            logger.info("控制台窗口关闭，Windows 只给数秒；立即强制终止 exec 子进程树");
            return reason;
          }
          logger.info(`收到 ${signal}，等待 exec 子进程退出…`);
          return undefined;
        },
        () => logger.info("仍在等待 exec 子进程退出；grace 结束后会 SIGKILL"),
      );
      try {
        await daemon.run(stop.controller.signal);
      } finally {
        stop.release();
        store.close();
        removeDaemonRecord(paths.daemonRecordPath, record);
        lock.release();
      }
    });
  },
});
