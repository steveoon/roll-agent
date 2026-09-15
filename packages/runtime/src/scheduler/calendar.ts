import { z } from "zod";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    // Accept named zones, not fixed numeric offsets: calendar rules must follow DST.
    if (/^[+-]/u.test(value)) return false;
    try {
      return Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone.length > 0;
    } catch {
      return false;
    }
  }, "timeZone 必须是有效的 IANA 时区，例如 Asia/Shanghai")
  .transform((value) => Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone);

const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "时间格式必须为 HH:mm");
const calendarFields = {
  time: clockTimeSchema,
  timeZone: timeZoneSchema,
};

export const calendarScheduleSchema = z.discriminatedUnion("frequency", [
  z.object({ frequency: z.literal("daily"), ...calendarFields }).strict(),
  z
    .object({
      frequency: z.literal("weekly"),
      ...calendarFields,
      weekdays: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    })
    .strict(),
]);
export type CalendarSchedule = z.output<typeof calendarScheduleSchema>;
export const calendarScheduleInputSchema = z.discriminatedUnion("frequency", [
  calendarScheduleSchema.options[0].extend({ timeZone: timeZoneSchema.optional() }),
  calendarScheduleSchema.options[1].extend({ timeZone: timeZoneSchema.optional() }),
]);
export type CalendarScheduleInput = z.input<typeof calendarScheduleInputSchema>;

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Encode civil components as UTC solely for arithmetic; this is not an instant in the zone. */
function civilMs(formatter: Intl.DateTimeFormat, instant: number): number {
  const fields = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const date = new Date(0);
  date.setUTCFullYear(
    Number(fields.get("year")),
    Number(fields.get("month")) - 1,
    Number(fields.get("day")),
  );
  date.setUTCHours(
    Number(fields.get("hour")),
    Number(fields.get("minute")),
    Number(fields.get("second")),
    0,
  );
  return date.getTime();
}

/** Verify candidates by round-trip: gaps have none; folds select the earlier instant once. */
function firstCivilInstant(formatter: Intl.DateTimeFormat, wallMs: number): number | undefined {
  const offsets = new Set<number>();
  // Capture offsets on both sides of transitions, including half-hour and date-line changes.
  for (const delta of [-48, -24, 0, 24, 48]) {
    const sample = wallMs + delta * HOUR_MS;
    offsets.add(civilMs(formatter, sample) - sample);
  }
  let first: number | undefined;
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (civilMs(formatter, candidate) === wallMs && (first === undefined || candidate < first)) {
      first = candidate;
    }
  }
  return first;
}

export function parseLocalStartAt(text: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(text);
  if (match === null) throw new Error("startAt 必须为 YYYY-MM-DDTHH:mm[:ss] 或带偏移的 ISO 时间");
  const [, year, month, day, hour, minute, second = "00"] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const wallMs = Date.parse(iso);
  if (!Number.isFinite(wallMs) || new Date(wallMs).toISOString() !== iso) {
    throw new Error("startAt 日期或时间不存在");
  }
  const instant = firstCivilInstant(dateFormatter(timeZone), wallMs);
  if (instant === undefined) {
    throw new Error("startAt 在该时区不存在（夏令时跳时），请指定其他时间");
  }
  return instant;
}

export function nextCalendarRunAtMs(calendar: CalendarSchedule, afterMs: number): number {
  const formatter = dateFormatter(calendar.timeZone);
  const local = new Date(civilMs(formatter, afterMs));
  local.setUTCHours(0, 0, 0, 0);
  const [hour, minute] = calendar.time.split(":").map(Number);
  // Two weeks cover a skipped weekly occurrence, including a skipped civil date.
  for (let day = 0; day <= 15; day += 1) {
    const date = new Date(local.getTime() + day * DAY_MS);
    const weekday = date.getUTCDay() || 7;
    if (calendar.frequency === "weekly" && !calendar.weekdays.includes(weekday)) continue;
    date.setUTCHours(hour ?? 0, minute ?? 0, 0, 0);
    const candidate = firstCivilInstant(formatter, date.getTime());
    if (candidate !== undefined && candidate > afterMs) return candidate;
  }
  throw new Error("无法在未来两周找到有效的日历触发时间");
}

export function describeCalendar(calendar: CalendarSchedule): string {
  const weekdays = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const days =
    calendar.frequency === "daily"
      ? "每天"
      : `每${calendar.weekdays.map((day) => weekdays[day]).join("、")}`;
  return `${days} ${calendar.time}（${calendar.timeZone}）`;
}
