import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { inspectDaemon } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
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
        const status = {
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
        };
        if (args.json) {
          printJson(status);
          return;
        }
        log.info(
          `daemon: ${status.daemon.liveness}${status.daemon.pid ? ` (pid ${String(status.daemon.pid)})` : ""}`,
        );
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
