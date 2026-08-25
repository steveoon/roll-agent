import { mkdirSync } from "node:fs";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import { FileCompanionLogger } from "../../companion-host/logger.ts";
import {
  AgentLifecycleBusyError,
  acquireAgentLifecycleLock,
} from "../../registry/process-manager.ts";
import { SchedulerDaemon } from "../../scheduler-host/daemon.ts";
import {
  createDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "../../scheduler-host/daemon-record.ts";
import { SCHEDULER_DAEMON_LOCK_NAME, createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { createInvocationSpawner } from "../../scheduler-host/spawn-invocation.ts";
import { log } from "../utils/output.ts";
import { createProcessAbortController } from "./companion-command-utils.ts";
import { loadRuntime, openScheduleStore, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "在前台运行定时任务 daemon（服务管理器使用的正式入口）" },
  args: {
    foreground: { type: "boolean", description: "明确以前台模式运行", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      if (args.foreground !== true) {
        throw new Error("Use `roll schedule daemon --foreground`");
      }
      const { config } = loadConfig();
      const paths = createSchedulerPaths(config.scheduler.dataDir);
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
      const logger = {
        info: (message: string) => {
          fileLogger.info(message);
          log.info(message);
        },
        error: (message: string) => {
          fileLogger.error(message);
          log.error(message);
        },
      };
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      const daemon = new SchedulerDaemon({
        store,
        workerId: record.workerId,
        maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
        spawnInvocation: createInvocationSpawner({
          invocation: createBundledRollInvocation(),
          logPath: paths.logPath,
        }),
        logger,
      });
      const processSignal = createProcessAbortController();
      try {
        await daemon.run(processSignal.controller.signal);
      } finally {
        processSignal.release();
        store.close();
        removeDaemonRecord(paths.daemonRecordPath, record);
        lock.release();
      }
    });
  },
});
