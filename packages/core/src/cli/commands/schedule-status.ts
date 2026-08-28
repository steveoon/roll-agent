import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { DAEMON_LIVENESS, inspectDaemon } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
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
  meta: { description: "查看 daemon 存活状态与定时任务统计" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const paths = createSchedulerPaths(config.scheduler.dataDir);
      const daemon = inspectDaemon(paths.daemonRecordPath);
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const schedules = store.listSchedules();
        const nextWakeAtMs = store.nextWakeAtMs();
        const serviceState = inspectSchedulerServiceState(schedulerServiceStatePath());
        const serviceInstalled =
          serviceState.status === "valid" &&
          serviceState.state.phase === SCHEDULER_SERVICE_STATE_PHASES.installed;
        const serviceInstalling =
          serviceState.status === "valid" &&
          serviceState.state.phase === SCHEDULER_SERVICE_STATE_PHASES.installing;
        const status = {
          dataDir: paths.dataDir,
          daemon: {
            liveness: daemon.liveness,
            pid: daemon.record?.pid,
            startedAt: daemon.record?.startedAt,
            logPath: paths.logPath,
          },
          schedules: {
            total: schedules.length,
            active: schedules.filter((s) => s.status === runtime.SCHEDULE_STATUSES.active).length,
            paused: schedules.filter((s) => s.status === runtime.SCHEDULE_STATUSES.paused).length,
          },
          nextWakeAt: nextWakeAtMs === undefined ? undefined : new Date(nextWakeAtMs).toISOString(),
          serviceInstalled,
          serviceInstalling,
        };
        if (args.json) {
          printJson(status);
          return;
        }
        log.info(`data-dir: ${status.dataDir}`);
        log.info(
          `daemon: ${status.daemon.liveness}${status.daemon.pid ? ` (pid ${String(status.daemon.pid)})` : ""}`,
        );
        if (status.serviceInstalling) {
          log.warn(
            "service metadata 仍为 installing（上次 install / restart / update 未完成），在恢复前不会领取任何任务；运行 roll schedule service status 查看原因，再用 roll schedule service restart 恢复",
          );
        }
        if (status.serviceInstalled && status.daemon.liveness !== DAEMON_LIVENESS.running) {
          log.warn(
            "已安装用户服务但 daemon 未运行；运行 roll schedule service status 查看原因（固化的 node / roll 路径失效、版本过期等），必要时 roll schedule service restart",
          );
        }
        log.info(
          `任务: ${String(status.schedules.total)} 个（active ${String(status.schedules.active)} / paused ${String(status.schedules.paused)}）`,
        );
        log.info(`下次唤醒: ${status.nextWakeAt ?? "-"}`);
        log.info(`日志: ${paths.logPath}`);
      } finally {
        store.close();
      }
    });
  },
});
