import { z } from "zod";
import type { ScheduleToolCreateRequest } from "@roll-agent/core/scheduler-host/schedule-tool-binding";
import { calendarScheduleSchema, timeZoneSchema } from "../scheduler/calendar.ts";

const interval = z
  .object({
    kind: z.literal("interval"),
    every: z
      .string()
      .trim()
      .min(1)
      .describe("两轮间隔，如 1m、30m（60s..365d）；用户未指定时先询问，不能猜测"),
  })
  .strict();
const daily = calendarScheduleSchema.options[0].omit({ frequency: true }).extend({
  kind: z.literal("daily"),
  timeZone: timeZoneSchema.nullable().describe("IANA 时区；null 使用并保存运行 Roll 的机器时区"),
});
const weekly = calendarScheduleSchema.options[1].omit({ frequency: true }).extend({
  kind: z.literal("weekly"),
  timeZone: daily.shape.timeZone,
});

/** Provider strict mode requires every property; null represents only declared defaults. */
export const scheduleCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).describe("任务名称"),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe("每轮执行的工作；不要把触发时间或停止条件只写在 prompt 中"),
    recurrence: z
      .discriminatedUnion("kind", [interval, daily, weekly])
      .describe(
        "重复规则：interval=固定间隔，daily=每天，weekly=每周。今天/明天某时只指定 startAt，不代表 daily。缺少两轮间隔时先询问用户",
      ),
    startAt: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "未来开始时间 YYYY-MM-DDTHH:mm 或带偏移 ISO；null 不指定。interval 首轮在此时执行，daily/weekly 在此时起找匹配日期；不是重复规则",
      ),
    cwd: z.string().nullable().describe("执行工作目录；null 使用当前会话目录"),
    rounds: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .describe("总自动轮数；null 不限。失败、取消、空结果占轮数；同轮重试和手动运行不额外计数"),
    maxRun: z.string().nullable().describe("单轮时长上限，如 1h（60s..24h）；null 使用默认 1 小时"),
  })
  .strict();

export function toScheduleCreateRequest(
  input: z.output<typeof scheduleCreateInputSchema>,
): ScheduleToolCreateRequest {
  const { recurrence, startAt, cwd, rounds, maxRun, name, prompt } = input;
  const common = {
    name,
    prompt,
    ...(startAt === null ? {} : { startAt }),
    ...(cwd === null ? {} : { cwd }),
    ...(rounds === null ? {} : { rounds }),
    ...(maxRun === null ? {} : { maxRun }),
  };
  if (recurrence.kind === "interval") return { ...common, every: recurrence.every };
  const calendar = {
    time: recurrence.time,
    ...(recurrence.timeZone === null ? {} : { timeZone: recurrence.timeZone }),
  };
  return {
    ...common,
    calendar:
      recurrence.kind === "daily"
        ? { frequency: "daily", ...calendar }
        : { frequency: "weekly", ...calendar, weekdays: recurrence.weekdays },
  };
}
