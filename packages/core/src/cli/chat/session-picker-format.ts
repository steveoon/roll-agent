export interface SessionPickerThread {
  readonly id: string;
  readonly title: string | undefined;
  readonly updatedAt: string;
}

export interface SessionPickerItem {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}

export interface BuildSessionPickerItemsOptions {
  readonly currentSessionId: string;
  readonly countMessages: (threadId: string) => number;
  readonly now: Date;
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
  return threads
    .filter((thread) => thread.id !== options.currentSessionId)
    .map((thread) => {
      const relative = formatRelativeTime(thread.updatedAt, options.now);
      const parts = [relative, `${String(options.countMessages(thread.id))} 条消息`];
      return {
        id: thread.id,
        title: thread.title ?? UNTITLED,
        meta: parts.filter((part) => part.length > 0).join(" · "),
      };
    });
}
