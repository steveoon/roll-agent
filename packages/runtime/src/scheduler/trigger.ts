import { z } from "zod";
import { SCHEDULER_LIMITS } from "./limits.ts";
import {
  calendarScheduleSchema,
  calendarScheduleInputSchema,
  describeCalendar,
  nextCalendarRunAtMs,
  parseLocalStartAt,
  systemTimeZone,
  timeZoneSchema,
} from "./calendar.ts";

export const TRIGGER_KINDS = { interval: "interval", calendar: "calendar" } as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[keyof typeof TRIGGER_KINDS];

export const intervalTriggerSchema = z
  .object({
    kind: z.literal(TRIGGER_KINDS.interval),
    everyMs: z
      .number()
      .int()
      .min(SCHEDULER_LIMITS.minIntervalMs)
      .max(SCHEDULER_LIMITS.maxIntervalMs),
    startAtMs: z.number().int().min(0).max(253_402_214_400_000).optional(),
    timeZone: timeZoneSchema.optional(),
  })
  .strict();

const calendarTriggerSchema = z
  .object({
    kind: z.literal(TRIGGER_KINDS.calendar),
    calendar: calendarScheduleSchema,
    startAtMs: z.number().int().min(0).max(253_402_214_400_000).optional(),
  })
  .strict();
export const triggerSpecSchema = z.discriminatedUnion("kind", [
  intervalTriggerSchema,
  calendarTriggerSchema,
]);
export type TriggerSpec = z.infer<typeof triggerSpecSchema>;

export const scheduleTimingInputSchema = z
  .object({
    every: z.string().trim().min(1).optional(),
    calendar: calendarScheduleInputSchema.optional(),
    startAt: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((input) => (input.every === undefined) !== (input.calendar === undefined), {
    message: "every 与 calendar 必须且只能提供一个",
  });
export type ScheduleTimingInput = z.input<typeof scheduleTimingInputSchema>;

export function createScheduleTrigger(input: ScheduleTimingInput, nowMs = Date.now()): TriggerSpec {
  const parsed = scheduleTimingInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ScheduleTriggerError(parsed.error.issues[0]?.message ?? "定时参数无效");
  }
  const value = parsed.data;
  const zone = value.calendar?.timeZone ?? systemTimeZone();
  let startAtMs: number | undefined;
  if (value.startAt !== undefined) {
    try {
      startAtMs = /(?:Z|[+-]\d{2}:\d{2})$/u.test(value.startAt)
        ? Date.parse(z.string().datetime({ offset: true }).parse(value.startAt))
        : parseLocalStartAt(value.startAt, zone);
    } catch (error) {
      throw new ScheduleTriggerError(
        `startAt 无效：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Number.isFinite(startAtMs) || startAtMs <= nowMs) {
      throw new ScheduleTriggerError("startAt 必须是未来时间");
    }
  }
  const start = startAtMs === undefined ? {} : { startAtMs };
  const raw =
    value.calendar !== undefined
      ? { kind: TRIGGER_KINDS.calendar, calendar: { ...value.calendar, timeZone: zone }, ...start }
      : {
          ...createIntervalTrigger(value.every ?? ""),
          ...start,
          ...(startAtMs === undefined ? {} : { timeZone: zone }),
        };
  const result = triggerSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new ScheduleTriggerError(result.error.issues[0]?.message ?? "定时参数无效");
  }
  return result.data;
}

export class ScheduleTriggerError extends Error {
  readonly code = "schedule_trigger_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScheduleTriggerError";
  }
}

const INTERVAL_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type IntervalUnit = keyof typeof INTERVAL_UNIT_MS;
const INTERVAL_PATTERN = /^(\d{1,9})([smhd])$/u;

function isIntervalUnit(value: string): value is IntervalUnit {
  return Object.hasOwn(INTERVAL_UNIT_MS, value);
}

export function formatDuration(ms: number): string {
  if (ms % INTERVAL_UNIT_MS.d === 0) {
    return `${String(ms / INTERVAL_UNIT_MS.d)} 天`;
  }
  if (ms % INTERVAL_UNIT_MS.h === 0) {
    return `${String(ms / INTERVAL_UNIT_MS.h)} 小时`;
  }
  if (ms % INTERVAL_UNIT_MS.m === 0) {
    return `${String(ms / INTERVAL_UNIT_MS.m)} 分钟`;
  }
  return `${String(Math.round(ms / INTERVAL_UNIT_MS.s))} 秒`;
}

export function formatInterval(ms: number): string {
  return `每 ${formatDuration(ms)}`;
}

interface DurationBounds {
  readonly label: string;
  readonly minMs: number;
  readonly maxMs: number;
}

function parseDurationText(text: string, bounds: DurationBounds): number {
  const trimmed = text.trim();
  const match = INTERVAL_PATTERN.exec(trimmed);
  const digits = match?.[1];
  const unit = match?.[2];
  if (digits === undefined || unit === undefined || !isIntervalUnit(unit)) {
    throw new ScheduleTriggerError(
      `无法识别的${bounds.label} "${trimmed}"：格式为 <数字><s|m|h|d>，例如 30m、2h、1d`,
    );
  }
  const value = Number.parseInt(digits, 10);
  if (value <= 0) {
    throw new ScheduleTriggerError(`${bounds.label}必须大于 0`);
  }
  const ms = value * INTERVAL_UNIT_MS[unit];
  if (ms < bounds.minMs) {
    throw new ScheduleTriggerError(
      `${bounds.label}不能小于 ${String(bounds.minMs / INTERVAL_UNIT_MS.s)} 秒（收到 ${trimmed}）`,
    );
  }
  if (ms > bounds.maxMs) {
    throw new ScheduleTriggerError(
      `${bounds.label}不能大于 ${formatDuration(bounds.maxMs)}（收到 ${trimmed}）`,
    );
  }
  return ms;
}

export function parseIntervalText(text: string): number {
  return parseDurationText(text, {
    label: "间隔",
    minMs: SCHEDULER_LIMITS.minIntervalMs,
    maxMs: SCHEDULER_LIMITS.maxIntervalMs,
  });
}

export function parseMaxRunText(text: string): number {
  return parseDurationText(text, {
    label: "单次运行上限",
    minMs: SCHEDULER_LIMITS.minMaxRunMs,
    maxMs: SCHEDULER_LIMITS.maxRunCeilingMs,
  });
}

export function createIntervalTrigger(text: string): z.infer<typeof intervalTriggerSchema> {
  return { kind: TRIGGER_KINDS.interval, everyMs: parseIntervalText(text) };
}

export function describeTrigger(trigger: TriggerSpec): string {
  const recurrence =
    trigger.kind === TRIGGER_KINDS.interval
      ? formatInterval(trigger.everyMs)
      : describeCalendar(trigger.calendar);
  if (trigger.startAtMs === undefined) return recurrence;
  const zone =
    trigger.kind === TRIGGER_KINDS.calendar
      ? trigger.calendar.timeZone
      : (trigger.timeZone ?? "UTC");
  const start = new Date(trigger.startAtMs).toLocaleString("zh-CN", {
    timeZone: zone,
    hour12: false,
  });
  return `${recurrence}，从 ${start}（${zone}）开始`;
}

export function computeNextRunAtMs(trigger: TriggerSpec, nowMs: number): number {
  if (trigger.kind === TRIGGER_KINDS.interval) {
    return Math.max(nowMs + trigger.everyMs, trigger.startAtMs ?? -Infinity);
  }
  return nextCalendarRunAtMs(trigger.calendar, Math.max(nowMs, (trigger.startAtMs ?? 0) - 1));
}

export function computeFirstRunAtMs(trigger: TriggerSpec, nowMs: number): number {
  if (trigger.startAtMs !== undefined && trigger.startAtMs <= nowMs) {
    throw new ScheduleTriggerError("startAt 必须是未来时间；开始时间已过，请重新创建");
  }
  if (trigger.kind === TRIGGER_KINDS.interval && trigger.startAtMs !== undefined) {
    return trigger.startAtMs;
  }
  return computeNextRunAtMs(trigger, nowMs);
}

export function parseTriggerJson(json: string): TriggerSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    throw new ScheduleTriggerError("trigger 不是合法 JSON");
  }
  const parsed = triggerSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScheduleTriggerError(
      `trigger 不合法（${parsed.error.issues[0]?.path.join(".") ?? ""}）：${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}
