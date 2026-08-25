import { z } from "zod";
import { SCHEDULER_LIMITS } from "./limits.ts";

export const TRIGGER_KINDS = { interval: "interval" } as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[keyof typeof TRIGGER_KINDS];

export const intervalTriggerSchema = z
  .object({
    kind: z.literal(TRIGGER_KINDS.interval),
    everyMs: z.number().int().min(SCHEDULER_LIMITS.minIntervalMs),
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

export function formatInterval(ms: number): string {
  if (ms % INTERVAL_UNIT_MS.d === 0) {
    return `每 ${String(ms / INTERVAL_UNIT_MS.d)} 天`;
  }
  if (ms % INTERVAL_UNIT_MS.h === 0) {
    return `每 ${String(ms / INTERVAL_UNIT_MS.h)} 小时`;
  }
  if (ms % INTERVAL_UNIT_MS.m === 0) {
    return `每 ${String(ms / INTERVAL_UNIT_MS.m)} 分钟`;
  }
  return `每 ${String(Math.round(ms / INTERVAL_UNIT_MS.s))} 秒`;
}

export function parseIntervalText(text: string): number {
  const trimmed = text.trim();
  const match = INTERVAL_PATTERN.exec(trimmed);
  const digits = match?.[1];
  const unit = match?.[2];
  if (digits === undefined || unit === undefined || !isIntervalUnit(unit)) {
    throw new ScheduleTriggerError(
      `无法识别的间隔 "${trimmed}"：格式为 <数字><s|m|h|d>，例如 30m、2h、1d`,
    );
  }
  const value = Number.parseInt(digits, 10);
  if (value <= 0) {
    throw new ScheduleTriggerError("间隔必须大于 0");
  }
  const ms = value * INTERVAL_UNIT_MS[unit];
  if (ms < SCHEDULER_LIMITS.minIntervalMs) {
    throw new ScheduleTriggerError(
      `间隔不能小于 ${String(SCHEDULER_LIMITS.minIntervalMs / INTERVAL_UNIT_MS.s)} 秒（收到 ${trimmed}）`,
    );
  }
  return ms;
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
