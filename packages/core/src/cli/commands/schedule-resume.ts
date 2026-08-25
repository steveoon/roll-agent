import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { computeAuthorityDigest } from "../../scheduler-host/authority.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  requireSchedule,
  runScheduleCommand,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "恢复已暂停的定时任务，并以当前权限配置重新授权" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const schedule = requireSchedule(store, args.id);
        const authorityDigest = computeAuthorityDigest(loadConfig({ cwd: schedule.cwd }).config);
        const now = Date.now();
        store.setAuthorityDigest(schedule.id, authorityDigest, now);
        store.setScheduleStatus(schedule.id, runtime.SCHEDULE_STATUSES.active, now);
        if (schedule.authorityDigest !== authorityDigest) {
          log.info("已按当前 runtime.approval / runtime.shell 配置重新记录权限边界。");
        }
        log.success(`已恢复定时任务 ${args.id}`);
      } finally {
        store.close();
      }
    });
  },
});
