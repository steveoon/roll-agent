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
        if (!store.resumeSchedule(schedule.id, authorityDigest, Date.now())) {
          throw new Error(`定时任务 ${args.id} 已被删除；用 roll schedule list 查看`);
        }
        if (schedule.authorityDigest !== authorityDigest) {
          log.warn(
            `权限边界摘要已变化（${schedule.authorityDigest?.slice(0, 15) ?? "未记录"} → ${authorityDigest.slice(0, 15)}），已按 ${schedule.cwd} 当前的 runtime.approval / runtime.shell 配置重新授权。`,
          );
        }
        log.success(`已恢复定时任务 ${args.id}`);
      } finally {
        store.close();
      }
    });
  },
});
