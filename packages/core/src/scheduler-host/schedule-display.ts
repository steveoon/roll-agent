import type { ScheduleRecord } from "@roll-agent/runtime";

export interface ScheduleTimingDisplay {
  readonly timeZone?: string;
  readonly nextRunAtDisplay?: string;
  readonly lastRunAtDisplay?: string;
}

/** Preserve the task's clock on clients whose local zone differs from the scheduler. */
export function describeScheduleTiming(record: ScheduleRecord): ScheduleTimingDisplay {
  const timeZone =
    record.trigger.kind === "calendar"
      ? record.trigger.calendar.timeZone
      : (record.trigger.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const format = (ms: number) =>
    `${new Date(ms).toLocaleString("zh-CN", { timeZone, hour12: false })}（${timeZone}）`;
  return {
    timeZone,
    ...(record.nextRunAtMs === undefined ? {} : { nextRunAtDisplay: format(record.nextRunAtMs) }),
    ...(record.lastRunAtMs === undefined ? {} : { lastRunAtDisplay: format(record.lastRunAtMs) }),
  };
}
