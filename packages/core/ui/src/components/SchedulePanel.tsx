import { useCallback, useEffect, useRef, useState } from "react";
import type { RollUiApi } from "../api.ts";
import {
  SCHEDULE_ADD_EXAMPLE,
  SCHEDULE_KILL_CONFIRM,
  deriveScheduleWarnings,
  describeRunStatus,
  describeScheduleAction,
  describeScheduleActionResult,
  getInvocationCancelMode,
  isScheduleUnavailableError,
  type ScheduleAction,
} from "../lib/schedule-state.ts";
import type { ScheduleRow, ScheduleRunRow, ScheduleStatusSummary } from "../types.ts";

export interface SchedulePanelProps {
  readonly api: RollUiApi;
  readonly onToast: (toast: {
    readonly tone: "success" | "warning";
    readonly message: string;
  }) => void;
  readonly onUnavailable: () => void;
}

const RUNS_LIMIT = 20;

export function SchedulePanel({ api, onToast, onUnavailable }: SchedulePanelProps) {
  const [status, setStatus] = useState<ScheduleStatusSummary>();
  const [schedules, setSchedules] = useState<readonly ScheduleRow[]>();
  const [runs, setRuns] = useState<readonly ScheduleRunRow[]>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<ScheduleAction>();
  const [busyTarget, setBusyTarget] = useState<string>();
  const [expandedRun, setExpandedRun] = useState<string>();
  const busyRef = useRef<ScheduleAction>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStatus, nextSchedules, nextRuns] = await Promise.all([
        api.getScheduleStatus(),
        api.listSchedules(),
        api.listScheduleRuns({ limit: RUNS_LIMIT }),
      ]);
      setStatus(nextStatus);
      setSchedules(nextSchedules);
      setRuns(nextRuns);
      setLoadError(undefined);
    } catch (error) {
      if (isScheduleUnavailableError(error)) {
        onUnavailable();
        return;
      }
      setLoadError(describeError(error));
    }
  }, [api, onUnavailable]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  async function runAction(
    action: ScheduleAction,
    body?: unknown,
    options: { readonly target?: string; readonly confirm?: string } = {},
  ): Promise<void> {
    if (busyRef.current !== undefined) return;
    const presentation = describeScheduleAction(action);
    const confirmText = options.confirm ?? presentation.confirm;
    if (confirmText !== undefined && !window.confirm(confirmText)) return;
    busyRef.current = action;
    setBusy(action);
    setBusyTarget(options.target);
    try {
      const result = await api.runScheduleAction(action, body);
      onToast(describeScheduleActionResult(action, result));
    } catch (error) {
      if (isScheduleUnavailableError(error)) {
        onUnavailable();
        return;
      }
      onToast({ tone: "warning", message: describeError(error) });
    } finally {
      busyRef.current = undefined;
      setBusy(undefined);
      setBusyTarget(undefined);
      await refresh();
    }
  }

  const acting = busy !== undefined;
  const warnings = status === undefined ? [] : deriveScheduleWarnings(status);

  return (
    <section className="companion-panel schedule-panel" aria-labelledby="schedule-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SCHEDULER</p>
          <h2 id="schedule-title">定时任务管理</h2>
        </div>
        <button
          type="button"
          className="icon-button refresh-button"
          aria-label="刷新定时任务状态"
          title="刷新定时任务状态"
          disabled={acting}
          onClick={() => {
            refresh().catch(() => undefined);
          }}
        >
          ↻
        </button>
      </div>
      <p className="section-description">
        查看任务与运行结果，管理开机自启的调度服务。新建任务请使用 CLI：
        <code>roll schedule add</code>；全局参数（数据目录、并发数）在「定时任务」配置分区调整。
      </p>

      {acting && busy !== undefined && (
        <div className="companion-busy" role="status">
          <span className="loading-bar" />
          <span>{describeScheduleAction(busy).progress}</span>
        </div>
      )}

      {loadError !== undefined && (
        <div className="companion-error" role="alert">
          <strong>状态读取失败</strong>
          <span>{loadError}</span>
          <small>点右上角 ↻ 重试。</small>
        </div>
      )}

      {warnings.map((warning) => (
        <div className="schedule-alert" role="alert" key={warning}>
          {warning}
        </div>
      ))}

      <ServiceCard status={status} acting={acting} onAction={runAction} />

      <section className="schedule-block" aria-labelledby="schedule-tasks-title">
        <div className="panel-heading-row">
          <div>
            <p className="eyebrow">TASKS</p>
            <h3 id="schedule-tasks-title">任务</h3>
          </div>
          {schedules !== undefined && schedules.length > 0 && (
            <span className="section-count">{String(schedules.length).padStart(2, "0")} 项</span>
          )}
        </div>
        {schedules === undefined ? (
          <LoadingRows label="正在读取任务列表" />
        ) : schedules.length === 0 ? (
          <p className="empty-inline">
            暂无定时任务。
            <small>用 CLI 新建：{SCHEDULE_ADD_EXAMPLE}</small>
          </p>
        ) : (
          <ul className="schedule-item-list">
            {schedules.map((schedule) => (
              <ScheduleItem
                key={schedule.id}
                schedule={schedule}
                busy={acting}
                pending={busyTarget === schedule.id}
                onToggle={() => {
                  const action = schedule.status === "active" ? "pause" : "resume";
                  runAction(action, { id: schedule.id }, { target: schedule.id }).catch(
                    () => undefined,
                  );
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="schedule-block" aria-labelledby="schedule-runs-title">
        <div className="panel-heading-row">
          <div>
            <p className="eyebrow">RECENT RUNS</p>
            <h3 id="schedule-runs-title">最近运行</h3>
          </div>
        </div>
        {runs === undefined ? (
          <LoadingRows label="正在读取运行记录" />
        ) : runs.length === 0 ? (
          <p className="empty-inline">
            暂无运行记录。
            <small>任务到期或 roll schedule run-now 触发后会出现在这里。</small>
          </p>
        ) : (
          <ul className="schedule-item-list">
            {runs.map((run) => (
              <RunItem
                key={run.id}
                run={run}
                busy={acting}
                pending={busyTarget === run.id}
                expanded={expandedRun === run.id}
                onToggleDetail={() => {
                  setExpandedRun(expandedRun === run.id ? undefined : run.id);
                }}
                onCancel={(kill) => {
                  runAction(
                    "cancel",
                    { id: run.id, ...(kill ? { kill: true } : {}) },
                    { target: run.id, ...(kill ? { confirm: SCHEDULE_KILL_CONFIRM } : {}) },
                  ).catch(() => undefined);
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

interface ServiceCardProps {
  readonly status: ScheduleStatusSummary | undefined;
  readonly acting: boolean;
  readonly onAction: (action: ScheduleAction) => Promise<void>;
}

function ServiceCard({ status, acting, onAction }: ServiceCardProps) {
  if (status === undefined) {
    return (
      <div className="status-loading" role="status">
        <span className="loading-bar" />
        <span className="loading-bar" />
        <span className="sr-only">正在读取调度服务状态</span>
      </div>
    );
  }
  const service = status.service;
  const tone = service.installed ? (service.running ? "ok" : "warn") : "off";
  const phaseLabel = service.installed
    ? service.running
      ? "运行中"
      : "已安装 · 未运行"
    : "未安装";
  const trigger = (action: ScheduleAction): void => {
    onAction(action).catch(() => undefined);
  };
  return (
    <article className="companion-status-card">
      <div className="companion-status-topline">
        <span className={`status-dot ${tone}`} aria-hidden="true" />
        <strong>调度服务</strong>
        <span className={`companion-phase ${tone}`}>{phaseLabel}</span>
      </div>
      <div className="companion-status-grid">
        <span>数据目录</span>
        <code>{status.dataDir}</code>
        <span>DAEMON</span>
        <code>
          {status.daemon.liveness}
          {status.daemon.pid !== undefined ? ` · pid ${String(status.daemon.pid)}` : ""}
        </code>
        <span>下次唤醒</span>
        <code>{status.nextWakeAt === undefined ? "—" : formatTime(status.nextWakeAt)}</code>
        {service.binary !== undefined && (
          <>
            <span>二进制</span>
            <code>
              {service.binary.status === "current"
                ? "与当前 roll 一致"
                : (service.binary.reason ?? service.binary.status)}
            </code>
          </>
        )}
        {service.error !== undefined && (
          <>
            <span>异常</span>
            <code>{service.error}</code>
          </>
        )}
      </div>
      <div className="companion-actions schedule-service-actions">
        {!service.installed ? (
          <button
            type="button"
            className="primary-button"
            disabled={acting}
            onClick={() => trigger("service-install")}
          >
            {describeScheduleAction("service-install").label}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={acting}
              onClick={() => trigger("service-restart")}
            >
              {describeScheduleAction("service-restart").label}
            </button>
            <button
              type="button"
              className="secondary-button danger-action"
              disabled={acting}
              onClick={() => trigger("service-uninstall")}
            >
              {describeScheduleAction("service-uninstall").label}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

interface ScheduleItemProps {
  readonly schedule: ScheduleRow;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly onToggle: () => void;
}

function ScheduleItem({ schedule, busy, pending, onToggle }: ScheduleItemProps) {
  const active = schedule.status === "active";
  return (
    <li className={pending ? "is-pending" : undefined}>
      <span className={`status-dot ${active ? "ok" : "off"}`} aria-hidden="true" />
      <div className="schedule-item-main">
        <div className="schedule-item-title">
          <strong>{schedule.name}</strong>
          <span className="schedule-pill neutral">{schedule.trigger}</span>
          {schedule.maxRun !== undefined && (
            <span className="schedule-pill neutral">单次 ≤ {schedule.maxRun}</span>
          )}
          {schedule.liveRun !== undefined && <span className="schedule-pill active">正在运行</span>}
        </div>
        <small>
          {active
            ? `下次运行 ${schedule.nextRunAt === undefined ? "—" : formatTime(schedule.nextRunAt)}`
            : "已暂停 · 恢复后按当前配置重新授权"}
          {schedule.lastRunAt !== undefined ? ` · 上次 ${formatTime(schedule.lastRunAt)}` : ""}
        </small>
        {schedule.lastError !== undefined && (
          <small className="schedule-item-error">{schedule.lastError}</small>
        )}
      </div>
      <button type="button" className="text-button" disabled={busy} onClick={onToggle}>
        {active ? "暂停" : "恢复"}
      </button>
    </li>
  );
}

interface RunItemProps {
  readonly run: ScheduleRunRow;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly expanded: boolean;
  readonly onToggleDetail: () => void;
  readonly onCancel: (kill: boolean) => void;
}

function RunItem({ run, busy, pending, expanded, onToggleDetail, onCancel }: RunItemProps) {
  const presentation = describeRunStatus(run.status);
  const cancelMode = getInvocationCancelMode(run.status);
  const detail = run.error ?? run.outputExcerpt;
  const duration = describeDuration(run);
  return (
    <li className={pending ? "is-pending" : undefined}>
      <span className={`schedule-pill ${presentation.tone}`}>{presentation.label}</span>
      <div className="schedule-item-main">
        <div className="schedule-item-title">
          <strong>{run.scheduleName}</strong>
          {run.attempt > 1 && (
            <span className="schedule-pill neutral">
              第 {String(run.attempt)}/{String(run.maxAttempts)} 次尝试
            </span>
          )}
        </div>
        <small>
          计划 {formatTime(run.scheduledFor)}
          {run.startedAt !== undefined ? ` · 开始 ${formatTime(run.startedAt)}` : ""}
          {duration !== undefined ? ` · 耗时 ${duration}` : ""}
        </small>
        {detail !== undefined && (
          <button
            type="button"
            className="text-button schedule-detail-toggle"
            onClick={onToggleDetail}
          >
            {expanded ? "收起详情" : run.error !== undefined ? "查看失败原因" : "查看输出摘要"}
          </button>
        )}
        {expanded && detail !== undefined && <pre className="schedule-run-detail">{detail}</pre>}
      </div>
      {cancelMode !== undefined && (
        <button
          type="button"
          className={`text-button${cancelMode === "kill" ? " schedule-danger" : ""}`}
          disabled={busy}
          onClick={() => onCancel(cancelMode === "kill")}
        >
          {cancelMode === "kill" ? "终止并取消" : "取消"}
        </button>
      )}
    </li>
  );
}

function LoadingRows({ label }: { readonly label: string }) {
  return (
    <div className="status-loading" role="status">
      <span className="loading-bar" />
      <span className="loading-bar" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function formatTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
}

function describeDuration(run: ScheduleRunRow): string | undefined {
  if (run.startedAt === undefined || run.finishedAt === undefined) return undefined;
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return "<1 秒";
  if (ms < 60_000) return `${String(Math.round(ms / 1_000))} 秒`;
  if (ms < 3_600_000) return `${String(Math.round(ms / 60_000))} 分钟`;
  return `${String(Math.round(ms / 360_000) / 10)} 小时`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "定时任务操作失败";
}
