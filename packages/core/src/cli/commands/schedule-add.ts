import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { computeAuthorityDigest } from "../../scheduler-host/authority.ts";
import { parseScheduleRounds } from "../../scheduler-host/schedule-rounds.ts";
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
    every: {
      type: "string",
      description: "固定间隔，如 30m、2h、1d（最短 60s；与 daily/weekly 三选一）",
    },
    daily: { type: "string", description: "每天执行的当地时间，如 08:00" },
    weekly: { type: "string", description: "每周执行的星期，如 mon,wed,fri（需配合 --at）" },
    at: { type: "string", description: "每周任务的当地时间，如 08:00" },
    "time-zone": {
      type: "string",
      description: "日历时区，例如 Asia/Shanghai；默认使用并保存本机时区",
    },
    "start-at": {
      type: "string",
      description: "未来开始时间，如 2026-09-16T08:00（本机/日历时区），也接受带偏移的 ISO 时间",
    },
    cwd: { type: "string", description: "任务运行的工作目录（默认当前目录）" },
    "max-run": {
      type: "string",
      description:
        "单次运行时长上限，如 90m、6h（60s..24h；缺省 1h，超过后由 daemon 终止并按失败重试）",
    },
    rounds: { type: "string", description: "最多自动执行轮数（正安全整数；省略不限轮数）" },
    now: { type: "boolean", description: "登记后立即触发一次", default: false },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      if (
        [args.every, args.daily, args.weekly].filter((value) => value !== undefined).length !== 1
      ) {
        throw new Error("--every、--daily、--weekly 必须且只能提供一个");
      }
      if (
        (args.weekly === undefined && args.at !== undefined) ||
        (args.weekly !== undefined && args.at === undefined)
      ) {
        throw new Error("--weekly 必须与 --at 同时使用");
      }
      if (args["time-zone"] !== undefined && args.every !== undefined) {
        throw new Error("--time-zone 仅用于 --daily/--weekly；间隔任务的 start-at 可指定 ISO 偏移");
      }
      if (args.now && (args.every === undefined || args["start-at"] !== undefined)) {
        throw new Error("--now 仅用于普通间隔任务，不能与日历规则或 --start-at 同时使用");
      }
      const dayNames = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
      const weekdays = args.weekly?.split(",").map((value) => {
        const day = value.trim().toLowerCase();
        const index = dayNames.indexOf(day);
        if (index < 0) {
          throw new Error(
            `--weekly 不支持的星期：${day || "（空值）"}；可选 ${dayNames.join(",")}`,
          );
        }
        return index + 1;
      });
      const zone = args["time-zone"] === undefined ? {} : { timeZone: args["time-zone"] };
      const runtime = await loadRuntime();
      const trigger = runtime.createScheduleTrigger({
        ...(args.every === undefined ? {} : { every: args.every }),
        ...(args.daily === undefined
          ? {}
          : { calendar: { frequency: "daily", time: args.daily, ...zone } }),
        ...(args.weekly === undefined
          ? {}
          : {
              calendar: {
                frequency: "weekly",
                time: args.at ?? "",
                weekdays: weekdays ?? [],
                ...zone,
              },
            }),
        ...(args["start-at"] === undefined ? {} : { startAt: args["start-at"] }),
      });
      const maxRounds = args.rounds === undefined ? undefined : parseScheduleRounds(args.rounds);
      const maxRunMs =
        args["max-run"] === undefined ? undefined : runtime.parseMaxRunText(args["max-run"]);
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
      const store = openScheduleStore(config, runtime);
      try {
        const record = store.createSchedule({
          name: args.name,
          prompt: args.prompt,
          cwd,
          trigger,
          fireImmediately: args.now,
          authorityDigest,
          ...(maxRounds === undefined ? {} : { maxRounds }),
          ...(maxRunMs === undefined ? {} : { maxRunMs }),
        });
        const serialized = serializeSchedule(record);
        if (args.json) {
          printJson(serialized);
          return;
        }
        log.success(
          `已登记定时任务 ${record.name}（${serialized.trigger}${serialized.maxRun === undefined ? "" : `，单次上限 ${serialized.maxRun}`}），${record.maxRounds === undefined ? "不限轮数" : `最多自动执行 ${String(record.maxRounds)} 轮`}，ID ${record.id}，下次运行 ${serialized.nextRunAt ?? "-"}`,
        );
        log.info("需要 roll schedule daemon 在运行才会触发；用 roll schedule status 查看。");
      } finally {
        store.close();
      }
    });
  },
});
