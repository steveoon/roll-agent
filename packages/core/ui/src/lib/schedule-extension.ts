import type { ScheduleRow } from "../types.ts";

export interface ScheduleExtensionSubmission {
  readonly request: {
    readonly id: string;
    readonly rounds: number;
    readonly expectedMaxRounds: number;
    readonly requestId: string;
  };
  readonly confirmation: string;
}

/** Preserve the original request after ambiguous failures, even when a refresh shows it applied. */
export function prepareScheduleExtension(
  schedule: ScheduleRow,
  amount: string,
  previous: ScheduleExtensionSubmission | undefined,
  createRequestId: () => string,
): ScheduleExtensionSubmission {
  const rounds = Number(amount);
  if (!/^\d+$/u.test(amount) || !Number.isSafeInteger(rounds) || rounds <= 0) {
    throw new Error("请输入要追加的正整数轮数。");
  }
  if (previous?.request.id === schedule.id && previous.request.rounds === rounds) {
    return previous;
  }
  const max = schedule.rounds.max;
  if (schedule.status !== "completed" || max === null || schedule.rounds.started < max) {
    throw new Error("只能为达到轮数上限且已结束的任务追加轮数；若上次结果不明确，请用原轮数重试。");
  }
  if (schedule.liveRun !== undefined) {
    throw new Error("还有运行未结算，请等待运行和进程树清场后再追加。");
  }
  const total = max + rounds;
  if (!Number.isSafeInteger(total)) {
    throw new Error("追加后的总轮数超出安全整数范围。");
  }
  return {
    request: { id: schedule.id, rounds, expectedMaxRounds: max, requestId: createRequestId() },
    confirmation: [
      `为「${schedule.name}」追加 ${String(rounds)} 轮？`,
      `总额度：${String(max)} → ${String(total)} 轮`,
      `已执行：${String(schedule.rounds.started)} 轮；追加后剩余：${String(total - schedule.rounds.started)} 轮`,
      `频率：${schedule.trigger}；从追加成功时刻起，等待一个周期后执行。`,
      `工作目录：${schedule.cwd}`,
      `任务内容：${schedule.prompt}`,
      "将按该工作目录的当前配置重新授权，保留任务 ID、累计轮数和运行历史。",
    ].join("\n"),
  };
}
