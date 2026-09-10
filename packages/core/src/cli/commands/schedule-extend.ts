import { randomUUID } from "node:crypto";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { computeAuthorityDigest } from "../../scheduler-host/authority.ts";
import { parseScheduleRounds } from "../../scheduler-host/schedule-rounds.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  requireSchedule,
  runScheduleCommand,
  serializeSchedule,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "给已结束的有限定时任务追加自动轮数，并按当前权限重新授权" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
    rounds: { type: "string", description: "追加轮数（正安全整数）", required: true },
    "request-id": { type: "string", description: "幂等请求 ID（重试必须复用，省略生成 UUID）" },
    "expected-max-rounds": {
      type: "string",
      description: "预期原总额度；省略读取当前额度或原请求回执",
    },
    json: { type: "boolean", default: false, description: "JSON 格式输出" },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const additionalRounds = parseScheduleRounds(args.rounds);
      const requestId = args["request-id"] ?? randomUUID();
      if (requestId.length < 1 || requestId.length > 128) {
        throw new Error("request-id 长度必须为 1..128");
      }
      // Persist this value in the caller's terminal/log before the first possible ledger write.
      log.info(`追加请求 ID: ${requestId}（重试请复用 --request-id）`);
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const schedule = requireSchedule(store, args.id);
        const receipt = store.getScheduleExtension(requestId);
        const expectedMaxRounds =
          args["expected-max-rounds"] === undefined
            ? (receipt?.expectedMaxRounds ?? schedule.maxRounds)
            : parseScheduleRounds(args["expected-max-rounds"]);
        if (expectedMaxRounds === undefined) throw new Error("不限轮数的任务不能追加轮数");
        const result = store.extendSchedule({
          scheduleId: args.id,
          additionalRounds,
          expectedMaxRounds,
          requestId,
          authorityDigest:
            receipt?.authorityDigest ??
            computeAuthorityDigest(loadConfig({ cwd: schedule.cwd }).config),
        });
        const response = {
          requestId,
          extended: result.extended,
          schedule: serializeSchedule(result.schedule),
        };
        if (args.json) {
          printJson(response);
          return;
        }
        log.success(
          `${result.extended ? "已追加" : "该请求已处理，未重复追加"}：${result.schedule.name}，${response.schedule.roundsDisplay}，下次运行 ${response.schedule.nextRunAt ?? "-"}`,
        );
      } finally {
        store.close();
      }
    });
  },
});
