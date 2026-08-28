import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { computeAuthorityDigest } from "../../scheduler-host/authority.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
  serializeSchedule,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "登记一个按周期运行的定时任务" },
  args: {
    prompt: {
      type: "positional",
      description: "每次触发时交给 roll chat 的任务描述",
      required: true,
    },
    name: { type: "string", description: "任务名称", required: true },
    every: { type: "string", description: "运行周期，如 30m、2h、1d（最短 60s）", required: true },
    cwd: { type: "string", description: "任务运行的工作目录（默认当前目录）" },
    "max-run": {
      type: "string",
      description:
        "单次运行时长上限，如 90m、6h（60s..24h；缺省 1h，超过后由 daemon 终止并按失败重试）",
    },
    now: { type: "boolean", description: "登记后立即触发一次", default: false },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const requestedCwd = resolve(args.cwd ?? process.cwd());
      let cwd: string | undefined;
      try {
        const real = realpathSync(requestedCwd);
        cwd = statSync(real).isDirectory() ? real : undefined;
      } catch {
        cwd = undefined;
      }
      if (cwd === undefined) {
        throw new Error(`cwd 不存在或不是目录：${requestedCwd}`);
      }
      const { config } = loadConfig();
      const authorityDigest = computeAuthorityDigest(loadConfig({ cwd }).config);
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const record = store.createSchedule({
          name: args.name,
          prompt: args.prompt,
          cwd,
          trigger: runtime.createIntervalTrigger(args.every),
          fireImmediately: args.now,
          authorityDigest,
          ...(args["max-run"] === undefined
            ? {}
            : { maxRunMs: runtime.parseMaxRunText(args["max-run"]) }),
        });
        const serialized = serializeSchedule(record);
        if (args.json) {
          printJson(serialized);
          return;
        }
        log.success(
          `已登记定时任务 ${record.name}（${serialized.trigger}${serialized.maxRun === undefined ? "" : `，单次上限 ${serialized.maxRun}`}），ID ${record.id}，下次运行 ${serialized.nextRunAt ?? "-"}`,
        );
        log.info("需要 roll schedule daemon 在运行才会触发；用 roll schedule status 查看。");
      } finally {
        store.close();
      }
    });
  },
});
