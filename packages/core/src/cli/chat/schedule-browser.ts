import type {
  AgentSession,
  InvocationMode,
  InvocationStatus,
  ScheduleStatus,
} from "@roll-agent/runtime";

export const SCHEDULE_PAGE_SIZE = 20;

export const STATUS_UNAVAILABLE_REASONS = {
  ledgerMissing: "ledger_missing",
  attemptNotCurrent: "attempt_not_current",
} as const;
export type StatusUnavailableReason =
  (typeof STATUS_UNAVAILABLE_REASONS)[keyof typeof STATUS_UNAVAILABLE_REASONS];

const INVOCATION_STATUS_LABELS: Readonly<Record<InvocationStatus, string>> = {
  pending: "等待执行",
  claimed: "准备执行",
  running: "执行中",
  retry: "等待重试",
  completed: "成功",
  needs_confirmation: "需要确认",
  failed: "失败",
};
const INVOCATION_MODE_LABELS: Readonly<Record<InvocationMode, string>> = {
  scheduled: "定时触发",
  manual: "手动触发",
};
const SCHEDULE_STATUS_LABELS: Readonly<Record<ScheduleStatus, string>> = {
  active: "已启用",
  paused: "已暂停",
};
const STATUS_UNAVAILABLE_LABELS: Readonly<Record<StatusUnavailableReason, string>> = {
  ledger_missing: "运行账本记录已不可用",
  attempt_not_current: "账本仅保留当前尝试的状态",
};

export function formatInvocationStatus(status: InvocationStatus | null): string {
  return status === null ? "历史状态不可用" : INVOCATION_STATUS_LABELS[status];
}

export function formatInvocationMode(mode: InvocationMode): string {
  return INVOCATION_MODE_LABELS[mode];
}

export function formatScheduleStatus(status: ScheduleStatus | null): string {
  return status === null ? "已移除" : SCHEDULE_STATUS_LABELS[status];
}

export interface ScheduleTaskItem {
  readonly id: string;
  readonly name: string;
  readonly trigger: string;
  readonly status: ScheduleStatus | null;
  readonly lastRunStatus?: InvocationStatus | null;
  readonly removed: boolean;
}

export interface ScheduleRunItem {
  readonly id: string;
  readonly scheduledAt: string;
  readonly mode: InvocationMode;
  readonly status: InvocationStatus | null;
  readonly excerpt?: string;
  readonly attempts: readonly number[];
}

export interface SchedulePageInput {
  readonly cursor?: string;
  readonly limit: typeof SCHEDULE_PAGE_SIZE;
}

export interface ScheduleRunPage {
  readonly items: readonly ScheduleRunItem[];
  readonly nextCursor?: string;
}

export interface ScheduleTranscriptPage {
  /** Literal, complete text for this page, including archived messages and tool evidence. */
  readonly text: string;
  readonly nextCursor?: string;
}

export interface ScheduleRunDetail {
  readonly invocationId: string;
  readonly taskName: string;
  readonly attempt: number;
  readonly attempts: readonly number[];
  readonly cwd: string;
  readonly mode: InvocationMode;
  readonly status: InvocationStatus | null;
  readonly statusUnavailableReason?: StatusUnavailableReason;
  readonly summary?: string;
  readonly error?: string;
  readonly sessionId?: string;
  readonly unavailableReason?: string;
  readonly canContinue: boolean;
}

/** Local CLI boundary: the host owns storage and session creation; viewers only navigate. */
export interface ScheduleBrowserPort {
  listTasks(): Promise<readonly ScheduleTaskItem[]>;
  listRuns(taskId: string, page: SchedulePageInput): Promise<ScheduleRunPage>;
  inspect(invocationId: string, attempt?: number): Promise<ScheduleRunDetail>;
  readTranscript(
    invocationId: string,
    page: SchedulePageInput & { readonly attempt: number },
  ): Promise<ScheduleTranscriptPage>;
  continueRun(invocationId: string, attempt: number): Promise<AgentSession>;
}

export function scheduleDetailText(detail: ScheduleRunDetail, currentCwd?: string): string {
  return [
    `${detail.taskName} · 第 ${String(detail.attempt)} 次尝试 · ${formatInvocationStatus(detail.status)}`,
    `运行：${detail.invocationId}`,
    `触发方式：${formatInvocationMode(detail.mode)}`,
    ...(detail.statusUnavailableReason === undefined
      ? []
      : [`状态说明：${STATUS_UNAVAILABLE_LABELS[detail.statusUnavailableReason]}`]),
    `原任务目录：${detail.cwd}`,
    ...(currentCwd === undefined ? [] : [`继续讨论使用的目录：${currentCwd}`]),
    ...(detail.sessionId === undefined ? [] : [`执行会话：${detail.sessionId}`]),
    ...(detail.summary === undefined ? [] : [`结果：${detail.summary}`]),
    ...(detail.error === undefined ? [] : [`错误：${detail.error}`]),
    ...(detail.unavailableReason === undefined ? [] : [detail.unavailableReason]),
  ].join("\n");
}

interface TasksView {
  readonly kind: "tasks";
  readonly tasks: readonly ScheduleTaskItem[];
}

interface RunsView {
  readonly kind: "runs";
  readonly parent: TasksView;
  readonly task: ScheduleTaskItem;
  readonly page: ScheduleRunPage;
  readonly cursors: readonly (string | undefined)[];
}

interface DetailView {
  readonly kind: "detail";
  readonly parent: RunsView;
  readonly detail: ScheduleRunDetail;
  readonly page: ScheduleTranscriptPage;
  readonly cursors: readonly (string | undefined)[];
}

export interface ScheduleBrowserState {
  readonly view: TasksView | RunsView | DetailView;
  readonly busy: boolean;
  readonly error?: string;
}

/** Shared navigation state for Ink and the basic REPL, including stale-read suppression. */
export class ScheduleBrowserController {
  readonly #port: ScheduleBrowserPort;
  readonly #listeners = new Set<() => void>();
  #version = 0;
  #continuing = false;
  #state: ScheduleBrowserState = { view: { kind: "tasks", tasks: [] }, busy: false };

  constructor(port: ScheduleBrowserPort) {
    this.#port = port;
  }

  getSnapshot = (): ScheduleBrowserState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(state: ScheduleBrowserState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  async #load(read: () => Promise<ScheduleBrowserState["view"]>): Promise<void> {
    if (this.#continuing) return;
    const version = ++this.#version;
    this.#set({ view: this.#state.view, busy: true });
    try {
      const view = await read();
      if (version === this.#version) this.#set({ view, busy: false });
    } catch (error) {
      if (version === this.#version) {
        this.#set({
          view: this.#state.view,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async refresh(): Promise<void> {
    const view = this.#state.view;
    return this.#load(async () => {
      if (view.kind === "tasks") return { kind: "tasks", tasks: await this.#port.listTasks() };
      if (view.kind === "runs") {
        return { ...view, page: await this.#port.listRuns(view.task.id, pageInput(view.cursors)) };
      }
      return this.#readDetail(
        view.parent,
        view.detail.invocationId,
        view.detail.attempt,
        view.cursors,
      );
    });
  }

  async choose(id: string): Promise<void> {
    if (this.#state.busy) return;
    const view = this.#state.view;
    if (view.kind === "tasks") {
      const task = view.tasks.find((item) => item.id === id);
      if (task === undefined) return;
      return this.#load(async () => ({
        kind: "runs",
        parent: view,
        task,
        cursors: [undefined],
        page: await this.#port.listRuns(id, { limit: SCHEDULE_PAGE_SIZE }),
      }));
    }
    if (view.kind === "runs" && view.page.items.some((item) => item.id === id)) {
      return this.#load(() => this.#readDetail(view, id));
    }
  }

  async #readDetail(
    parent: RunsView,
    invocationId: string,
    attempt?: number,
    cursors: readonly (string | undefined)[] = [undefined],
  ): Promise<DetailView> {
    const detail = await this.#port.inspect(invocationId, attempt);
    const page =
      detail.sessionId === undefined || detail.unavailableReason !== undefined
        ? { text: detail.unavailableReason ?? "会话未创建" }
        : await this.#port.readTranscript(invocationId, {
            ...pageInput(cursors),
            attempt: detail.attempt,
          });
    return { kind: "detail", parent, detail, cursors, page };
  }

  /** Returns false at the root. Pending reads are discarded; an in-flight fork must settle. */
  back(): boolean {
    if (this.#continuing) return true;
    this.#version += 1;
    const view = this.#state.view;
    if (view.kind === "tasks") return false;
    this.#set({ view: view.parent, busy: false });
    return true;
  }

  async page(direction: 1 | -1): Promise<void> {
    if (this.#state.busy) return;
    const view = this.#state.view;
    if (view.kind === "tasks") return;
    const next = view.page.nextCursor;
    if (direction === 1 && next === undefined) return;
    if (direction === -1 && view.cursors.length === 1) return;
    const cursors = direction === 1 ? [...view.cursors, next] : view.cursors.slice(0, -1);
    return this.#load(async () =>
      view.kind === "runs"
        ? { ...view, cursors, page: await this.#port.listRuns(view.task.id, pageInput(cursors)) }
        : this.#readDetail(view.parent, view.detail.invocationId, view.detail.attempt, cursors),
    );
  }

  async changeAttempt(direction: 1 | -1): Promise<void> {
    if (this.#state.busy) return;
    const view = this.#state.view;
    if (view.kind !== "detail") return;
    const index = view.detail.attempts.indexOf(view.detail.attempt);
    const attempt = view.detail.attempts[index + direction];
    if (attempt === undefined) return;
    return this.#load(() => this.#readDetail(view.parent, view.detail.invocationId, attempt));
  }

  async continueRun(): Promise<AgentSession | undefined> {
    const { view, busy } = this.#state;
    if (busy || view.kind !== "detail" || !view.detail.canContinue) return undefined;
    this.#continuing = true;
    this.#set({ view, busy: true });
    try {
      const session = await this.#port.continueRun(view.detail.invocationId, view.detail.attempt);
      this.#set({ view, busy: false });
      return session;
    } catch (error) {
      this.#set({
        view,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      this.#continuing = false;
    }
  }
}

function pageInput(cursors: readonly (string | undefined)[]): SchedulePageInput {
  const cursor = cursors.at(-1);
  return { limit: SCHEDULE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}
