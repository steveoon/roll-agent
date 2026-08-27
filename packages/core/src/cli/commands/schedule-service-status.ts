import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { isDaemonWorkerId } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import {
  createSchedulerServiceController,
  defaultSchedulerServiceSettings,
} from "../../scheduler-host/service.ts";
import {
  inspectSchedulerServiceState,
  schedulerServiceStatePath,
} from "../../scheduler-host/service-state.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "查看定时任务 daemon 用户服务的安装与运行状态" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const state = inspectSchedulerServiceState(schedulerServiceStatePath());
      let config: ReturnType<typeof loadConfig>["config"] | undefined;
      let configError: string | undefined;
      try {
        config = loadConfig().config;
      } catch (error) {
        if (process.platform !== "win32" && state.status !== "valid") {
          throw error;
        }
        configError = error instanceof Error ? error.message : String(error);
      }
      const configuredPaths =
        config === undefined ? undefined : createSchedulerPaths(config.scheduler.dataDir);
      const installedSettings =
        state.status === "valid"
          ? state.state
          : config === undefined || configuredPaths === undefined
            ? process.platform === "win32"
              ? defaultSchedulerServiceSettings()
              : undefined
            : {
                dataDir: configuredPaths.dataDir,
                maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
              };
      if (installedSettings === undefined) {
        throw new Error("无法从配置或 service metadata 确定 scheduler service 设置");
      }
      const status = await createSchedulerServiceController({
        dataDir: installedSettings.dataDir,
        maxConcurrentRuns: installedSettings.maxConcurrentRuns,
      }).status();
      let liveDaemonInvocations: number | undefined;
      let ledgerError: string | undefined;
      if (process.platform === "win32" && state.status === "valid") {
        try {
          const runtime = await loadRuntime();
          const store = openScheduleStore(config, runtime, {
            dataDir: state.state.dataDir,
            requireExistingDatabase: true,
          });
          try {
            liveDaemonInvocations = store
              .listActiveWorkerInvocations()
              .filter((row) => isDaemonWorkerId(row.claimedBy)).length;
          } finally {
            store.close();
          }
        } catch (error) {
          ledgerError = error instanceof Error ? error.message : String(error);
        }
      }
      const details = {
        ...status,
        metadataStatus: state.status,
        metadataPhase: state.status === "valid" ? state.state.phase : undefined,
        installedDataDir: state.status === "valid" ? state.state.dataDir : undefined,
        configuredDataDir: configuredPaths?.dataDir,
        configDrift:
          state.status === "valid" &&
          configuredPaths !== undefined &&
          state.state.dataDir !== configuredPaths.dataDir,
        liveDaemonInvocations,
        cleanupRequired: status.enabled === false && (liveDaemonInvocations ?? 0) > 0,
        metadataError: state.status === "invalid" ? state.error : undefined,
        ledgerError,
        configError,
      };
      if (args.json) {
        printJson(details);
        return;
      }
      log.info(`installed: ${status.installed ? "是" : "否"}`);
      log.info(`running: ${status.running ? "是" : "否"}`);
      if (status.enabled !== undefined) {
        log.info(`enabled: ${status.enabled ? "是" : "否"}`);
      }
      if (status.queued === true) {
        log.warn("Task Scheduler 正在排队启动 daemon；uninstall 会先 Disable 再 End");
      }
      if (status.indeterminate === true) {
        log.warn("Task Scheduler 状态未知；管理操作仍会先 Disable/End 并验证最终状态");
      }
      log.info(`metadata: ${details.metadataStatus}`);
      if (details.metadataPhase !== undefined) {
        log.info(`metadata phase: ${details.metadataPhase}`);
      }
      if (details.installedDataDir !== undefined) {
        log.info(`installed data-dir: ${details.installedDataDir}`);
      }
      if (details.configDrift) {
        log.warn(`当前配置 data-dir 已变化: ${details.configuredDataDir}`);
      }
      if (details.liveDaemonInvocations !== undefined) {
        log.info(`live daemon invocations: ${String(details.liveDaemonInvocations)}`);
      }
      if (details.cleanupRequired) {
        log.warn("服务已 disabled，但仍有 daemon invocation 需要完成收尾；请重试 uninstall");
      }
      if (details.metadataError !== undefined) {
        log.warn(details.metadataError);
      }
      if (details.ledgerError !== undefined) {
        log.warn(`ledger: ${details.ledgerError}`);
      }
      if (details.configError !== undefined) {
        log.warn(`config: ${details.configError}`);
      }
    });
  },
});
