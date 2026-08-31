import { z } from "zod";
import { SCHEDULER_LIMITS } from "./limits.ts";

export const TRIGGER_KINDS = { interval: "interval" } as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[keyof typeof TRIGGER_KINDS];

export const intervalTriggerSchema = z
  .object({
    kind: z.literal(TRIGGER_KINDS.interval),
    everyMs: z
      .number()
      .int()
      .min(SCHEDULER_LIMITS.minIntervalMs)
      .max(SCHEDULER_LIMITS.maxIntervalMs),
  })
  .strict();

export const triggerSpecSchema = z.discriminatedUnion("kind", [intervalTriggerSchema]);
export type TriggerSpec = z.infer<typeof triggerSpecSchema>;

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

export function createIntervalTrigger(text: string): TriggerSpec {
  return { kind: TRIGGER_KINDS.interval, everyMs: parseIntervalText(text) };
}

export function describeTrigger(trigger: TriggerSpec): string {
  return formatInterval(trigger.everyMs);
}

export function computeNextRunAtMs(trigger: TriggerSpec, nowMs: number): number {
  return nowMs + trigger.everyMs;
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
      `trigger 不合法：${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}
