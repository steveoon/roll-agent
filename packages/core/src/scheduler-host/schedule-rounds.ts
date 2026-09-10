import type { ScheduleRecord } from "@roll-agent/runtime";

/** Describe automatic rounds only; manual runs never replace the final automatic run. */
export function describeScheduleRounds(record: ScheduleRecord): string {
  if (record.maxRounds === undefined) {
    return "不限轮数";
  }
  const progress = `${String(record.roundsStarted)}/${String(record.maxRounds)} 轮`;
  if (record.status === "completed") {
    return `已结束 · 达到轮数上限 · ${progress}`;
  }
  if (record.roundsStarted < record.maxRounds) {
    return `已触发 ${progress}`;
  }
  const run = record.lastScheduledRun;
  if (run?.treeUnsettled) {
    return `${progress}已触发 · 最后一轮等待清场`;
  }
  const stages = {
    pending: "等待执行",
    claimed: "等待执行",
    running: "执行中",
    retry: "等待重试",
    completed: "等待结算",
    needs_confirmation: "等待结算",
    failed: "等待结算",
  } as const;
  return `${progress}已触发 · 最后一轮${run === undefined ? "等待结算" : stages[run.status]}`;
}

export function parseScheduleRounds(text: string): number {
  const value = Number(text);
  if (!/^[0-9]+$/u.test(text) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("rounds 必须是正安全整数");
  }
  return value;
}
