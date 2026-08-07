import type { CompanionPhase, CompanionStatus } from "../types.ts";

export const COMPANION_ACTION_PATHS = {
  enroll: "/api/companion/enroll",
  unenroll: "/api/companion/unenroll",
  enable: "/api/companion/enable",
  disable: "/api/companion/disable",
  workspace: "/api/companion/workspace",
  "service-install": "/api/companion/service/install",
  "service-uninstall": "/api/companion/service/uninstall",
  start: "/api/companion/start",
  stop: "/api/companion/stop",
  restart: "/api/companion/restart",
} as const;

export type CompanionAction = keyof typeof COMPANION_ACTION_PATHS;

export const COMPANION_STATUS_POLL_INTERVAL_MS = 2_000;
export const COMPANION_LOG_MAX_LINES = 2_000;

export type CompanionTone = "ok" | "warn" | "off";

export interface CompanionPhasePresentation {
  readonly label: string;
  readonly tone: CompanionTone;
}

export interface CompanionActionPresentation {
  readonly label: string;
  readonly progress: string;
  readonly confirm?: string;
}

const COMPANION_PHASE_PRESENTATION: Readonly<Record<CompanionPhase, CompanionPhasePresentation>> = {
  stopped: { label: "已停止", tone: "off" },
  starting: { label: "启动中", tone: "warn" },
  running: { label: "运行中", tone: "ok" },
  recovering: { label: "恢复中", tone: "warn" },
  stopping: { label: "停止中", tone: "warn" },
};

const COMPANION_ACTION_PRESENTATION: Readonly<
  Record<CompanionAction, CompanionActionPresentation>
> = {
  enroll: { label: "绑定设备", progress: "正在绑定设备…" },
  unenroll: {
    label: "解除绑定",
    progress: "正在解除绑定（最长约 1 分钟）…",
    confirm: "解除绑定会停止 Companion、删除本机凭据与配置。确认继续？",
  },
  enable: { label: "启用", progress: "正在启用…" },
  disable: { label: "停用", progress: "正在停用（最长约 1 分钟）…" },
  workspace: { label: "保存 Workspace", progress: "正在切换 workspace（最长约 1 分钟）…" },
  "service-install": { label: "安装后台服务", progress: "正在安装后台服务（最长约 1 分钟）…" },
  "service-uninstall": {
    label: "卸载后台服务",
    progress: "正在卸载后台服务（最长约 1 分钟）…",
    confirm: "卸载后台服务后，Companion 不再随登录自动启动。确认继续？",
  },
  start: { label: "启动", progress: "正在启动…" },
  stop: { label: "停止", progress: "正在停止（最长约 1 分钟）…" },
  restart: { label: "重启", progress: "正在重启（最长约 1 分钟）…" },
};

export function describeCompanionPhase(phase: CompanionPhase): CompanionPhasePresentation {
  return COMPANION_PHASE_PRESENTATION[phase];
}

export function describeCompanionAction(action: CompanionAction): CompanionActionPresentation {
  return COMPANION_ACTION_PRESENTATION[action];
}

/**
 * Mirrors the guards inside CompanionApplication so unavailable operations are disabled
 * instead of failing server-side: start/restart/service install need an enabled enrollment,
 * and everything except enroll needs an enrolled host.
 */
export function getCompanionActionAvailability(
  status: CompanionStatus | undefined,
  busy: boolean,
): Readonly<Record<CompanionAction, boolean>> {
  const ready = !busy && status !== undefined;
  const enrolled = ready && status.enrolled;
  const enabled = enrolled && status.enabled;
  return {
    enroll: ready && !status.enrolled,
    unenroll: enrolled,
    enable: enrolled && !status.enabled,
    disable: enabled,
    workspace: enrolled,
    "service-install": enabled,
    "service-uninstall": enrolled,
    start: enabled,
    stop: enrolled,
    restart: enabled,
  };
}

export function limitCompanionLogLines(text: string, maxLines = COMPANION_LOG_MAX_LINES): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(lines.length - maxLines).join("\n");
}

export function appendCompanionLogText(
  current: string,
  chunk: string,
  maxLines = COMPANION_LOG_MAX_LINES,
): string {
  return limitCompanionLogLines(`${current}${chunk}`, maxLines);
}

export function isCompanionUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    error.status === 404 &&
    "code" in error &&
    error.code === "companion_unavailable"
  );
}

export function describeCompanionWorkspaceDraft(draft: string): string | undefined {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return "请填写 workspace 绝对路径。";
  if (!trimmed.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(trimmed)) {
    return "workspace 必须是绝对路径。";
  }
  return undefined;
}
