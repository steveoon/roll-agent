import type { SessionOccupancy } from "@roll-agent/protocol";

export interface SessionPickerThread {
  readonly id: string;
  readonly title: string | undefined;
  readonly updatedAt: string;
  readonly workspace?: string;
}

export interface SessionPickerItem {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly group?: string;
  readonly canAssignToProject?: boolean;
  readonly isCurrent?: boolean;
  readonly history?: {
    readonly updated: string;
    readonly messageCount: number;
    readonly occupancy?: SessionOccupancy;
  };
}

export interface SessionPickerSelection {
  readonly threadId: string;
  readonly assignToCurrentProject?: boolean;
}

export const SESSION_HISTORY_GROUPS = {
  project: "本项目下的对话",
  legacy: "旧会话",
  other: "其他项目下的对话",
} as const;

export function sessionPickerGroups(items: readonly SessionPickerItem[]): readonly string[] {
  const groups = [
    ...new Set(items.flatMap((item) => (item.group === undefined ? [] : [item.group]))),
  ];
  return groups.length === 0
    ? []
    : [
        SESSION_HISTORY_GROUPS.project,
        SESSION_HISTORY_GROUPS.legacy,
        ...groups.filter(
          (group) =>
            group !== SESSION_HISTORY_GROUPS.project && group !== SESSION_HISTORY_GROUPS.legacy,
        ),
      ];
}

export interface BuildSessionPickerItemsOptions {
  readonly currentSessionId: string;
  readonly countMessages: (threadId: string) => number;
  readonly now: Date;
  readonly occupancy?: (threadId: string) => SessionOccupancy;
  readonly workspace?: string;
  readonly allProjects?: boolean;
}

const UNTITLED = "（无标题）";

export function formatRelativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const diffMs = now.getTime() - then;
  if (diffMs < 60_000) {
    return "刚刚";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${String(minutes)} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${String(days)} 天前`;
  }
  return iso.slice(0, 10);
}

export function buildSessionPickerItems(
  threads: readonly SessionPickerThread[],
  options: BuildSessionPickerItemsOptions,
): SessionPickerItem[] {
  const groupFor = (thread: SessionPickerThread) =>
    thread.workspace === undefined
      ? SESSION_HISTORY_GROUPS.legacy
      : thread.workspace === options.workspace
        ? SESSION_HISTORY_GROUPS.project
        : SESSION_HISTORY_GROUPS.other;
  const selected = threads.filter(
    (thread) =>
      thread.id === options.currentSessionId ||
      options.workspace === undefined ||
      options.allProjects ||
      thread.workspace === undefined ||
      thread.workspace === options.workspace,
  );
  if (options.workspace !== undefined) {
    const order = Object.values(SESSION_HISTORY_GROUPS);
    selected.sort((a, b) => order.indexOf(groupFor(a)) - order.indexOf(groupFor(b)));
  }
  return selected.map((thread) => {
    const isCurrent = thread.id === options.currentSessionId;
    const messageCount = options.countMessages(thread.id);
    const relative = formatRelativeTime(thread.updatedAt, options.now);
    const occupancy = isCurrent ? undefined : options.occupancy?.(thread.id);
    const status =
      occupancy?.status === "occupied"
        ? `占用中 · ${occupancy.owner?.label ?? "其他客户端"}`
        : occupancy?.status === "unknown"
          ? "状态未知"
          : "";
    const parts = [relative, `${String(messageCount)} 条消息`, status];
    return {
      id: thread.id,
      title: thread.title ?? (isCurrent && messageCount === 0 ? "（新会话，暂无消息）" : UNTITLED),
      meta: parts.filter((part) => part.length > 0).join(" · "),
      history: {
        updated: relative,
        messageCount,
        ...(occupancy === undefined ? {} : { occupancy }),
      },
      ...(isCurrent ? { isCurrent: true } : {}),
      ...(options.workspace === undefined
        ? {}
        : {
            group: groupFor(thread),
            ...(thread.workspace === undefined ? { canAssignToProject: true } : {}),
          }),
    };
  });
}
