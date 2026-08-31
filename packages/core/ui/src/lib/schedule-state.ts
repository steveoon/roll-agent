import type { ScheduleStatusSummary } from "../types.ts";

export const SCHEDULE_ACTION_PATHS = {
  "service-install": "/api/schedule/service/install",
  "service-restart": "/api/schedule/service/restart",
  "service-uninstall": "/api/schedule/service/uninstall",
  pause: "/api/schedule/pause",
  resume: "/api/schedule/resume",
  cancel: "/api/schedule/cancel",
} as const;

export type ScheduleAction = keyof typeof SCHEDULE_ACTION_PATHS;

export interface ScheduleActionPresentation {
  readonly label: string;
  readonly progress: string;
  readonly confirm?: string;
}

const SCHEDULE_ACTION_PRESENTATIONS: Readonly<Record<ScheduleAction, ScheduleActionPresentation>> =
  {
    "service-install": {
      label: "安装服务",
      progress: "正在安装并启动定时任务服务（最长约 1 分钟）…",
    },
    "service-restart": {
      label: "重启服务",
      progress: "正在重启定时任务服务（有任务在执行时会拒绝）…",
    },
    "service-uninstall": {
      label: "卸载服务",
      progress: "正在停止并卸载定时任务服务…",
      confirm: "停止并卸载定时任务服务？所有任务将不再自动运行；账本保留，重新安装后按原计划继续。",
    },
    pause: { label: "暂停", progress: "正在暂停任务…" },
    resume: { label: "恢复", progress: "正在恢复任务并按当前配置重新授权…" },
    cancel: { label: "取消", progress: "正在取消这次运行…" },
  };

export function describeScheduleAction(action: ScheduleAction): ScheduleActionPresentation {
  return SCHEDULE_ACTION_PRESENTATIONS[action];
}

export const SCHEDULE_ADD_EXAMPLE =
  'roll schedule add "每次触发时要做的事" --name 任务名 --every 30m';

export interface ScheduleActionResultPresentation {
  readonly tone: "success" | "warning";
  readonly message: string;
}

export function describeScheduleActionResult(
  action: ScheduleAction,
  result: Readonly<Record<string, unknown>> | undefined,
): ScheduleActionResultPresentation {
  const label = describeScheduleAction(action).label;
  if (result?.unverifiedDescendants === true) {
    return {
      tone: "warning",
      message: `${label}已完成，但当前平台无法验证 exec 后代进程是否全部退出；若有残留子进程请手动检查。`,
    };
  }
  if (result?.authorityChanged === true) {
    return { tone: "success", message: `${label}已完成；权限边界已按当前配置重新授权。` };
  }
  return { tone: "success", message: `${label}已完成。` };
}

export const SCHEDULE_KILL_CONFIRM =
  "终止并取消这次正在执行的运行？会向整个 exec 进程树发送终止信号，并在 5 秒内确认全部退出后才写入取消；确认失败则不会取消。任务本身不受影响，下个周期仍会触发。";

export type ScheduleRunTone = "ok" | "error" | "warn" | "active" | "neutral";

export interface ScheduleRunPresentation {
  readonly label: string;
  readonly tone: ScheduleRunTone;
}

const RUN_STATUS_PRESENTATIONS: Readonly<Record<string, ScheduleRunPresentation>> = {
  pending: { label: "排队中", tone: "neutral" },
  claimed: { label: "已领取", tone: "active" },
  running: { label: "运行中", tone: "active" },
  retry: { label: "等待重试", tone: "warn" },
  completed: { label: "成功", tone: "ok" },
  needs_confirmation: { label: "需人工确认", tone: "warn" },
  failed: { label: "失败", tone: "error" },
};

export function describeRunStatus(status: string): ScheduleRunPresentation {
  return RUN_STATUS_PRESENTATIONS[status] ?? { label: status, tone: "neutral" };
}

export type InvocationCancelMode = "cancel" | "kill";

export function getInvocationCancelMode(status: string): InvocationCancelMode | undefined {
  if (status === "pending" || status === "claimed" || status === "retry") {
    return "cancel";
  }
  if (status === "running") {
    return "kill";
  }
  return undefined;
}

export function deriveScheduleWarnings(status: ScheduleStatusSummary): readonly string[] {
  const warnings: string[] = [];
  if (
    status.service.installedDataDir !== undefined &&
    status.service.installedDataDir !== status.dataDir
  ) {
    warnings.push(
      `已安装的调度服务仍固定在旧数据目录 ${status.service.installedDataDir}，当前配置与下方列表读取的是 ${status.dataDir}。旧目录中的任务仍会被执行，但不在下方显示，下方操作也不影响它们；重启服务可切换到当前目录（账本不会自动搬迁）。`,
    );
  }
  if (status.service.metadataStatus === "invalid") {
    warnings.push(
      "定时任务服务 metadata 无效（fail-closed）：修复前所有任务领取都会被阻塞；先卸载再重新安装服务。",
    );
  }
  if (status.service.metadataPhase === "installing") {
    warnings.push("上次服务安装 / 重启 / 更新未完成，恢复前不会领取任何任务；重启服务可恢复。");
  }
  if (!status.service.installed && status.schedules.active > 0) {
    warnings.push("尚未安装定时任务服务：任务不会自动运行，重启电脑后也不会恢复；请安装服务。");
  }
  if (status.service.binary?.status === "outdated" || status.service.binary?.status === "broken") {
    warnings.push(
      `服务固化的 roll / Node 已${status.service.binary.status === "broken" ? "失效" : "过期"}${status.service.binary.reason === undefined ? "" : `（${status.service.binary.reason}）`}；重启服务以按当前版本重装。`,
    );
  }
  if (status.service.installed && status.daemon.liveness !== "running") {
    warnings.push("已安装服务但 daemon 未运行；重启服务，或查看 daemon 日志排查。");
  }
  return warnings;
}

export function isScheduleUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404 &&
    "code" in error &&
    (error as { code: unknown }).code === "schedule_unavailable"
  );
}
