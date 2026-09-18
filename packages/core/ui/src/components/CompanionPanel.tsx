import type { EnvironmentDiagnostics } from "../../../src/config/environment-diagnostic-schema.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RollUiApi } from "../api.ts";
import {
  COMPANION_STATUS_POLL_INTERVAL_MS,
  describeCompanionAction,
  describeCompanionPhase,
  describeCompanionWorkspaceDraft,
  getCompanionActionAvailability,
  isCompanionUnavailableError,
  type CompanionAction,
} from "../lib/companion-state.ts";
import type { CompanionDoctorResult, CompanionStatus } from "../types.ts";
import { CompanionLogsPanel } from "./CompanionLogsPanel.tsx";

export interface CompanionPanelProps {
  readonly api: RollUiApi;
  readonly onToast: (toast: {
    readonly tone: "success" | "warning";
    readonly message: string;
  }) => void;
  readonly onUnavailable: () => void;
}

const LIFECYCLE_ACTIONS: readonly CompanionAction[] = [
  "start",
  "stop",
  "restart",
  "enable",
  "disable",
  "service-install",
  "service-uninstall",
  "unenroll",
];

export function CompanionPanel({ api, onToast, onUnavailable }: CompanionPanelProps) {
  const [status, setStatus] = useState<CompanionStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [busy, setBusy] = useState<CompanionAction>();
  const [pairingCode, setPairingCode] = useState("");
  const [enrollWorkspace, setEnrollWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [doctor, setDoctor] = useState<CompanionDoctorResult>();
  const [doctorLoading, setDoctorLoading] = useState(false);
  const busyRef = useRef<CompanionAction>(undefined);
  const workspaceTouchedRef = useRef(false);

  const readStatus = useCallback(async (): Promise<CompanionStatus | undefined> => {
    try {
      const next = await api.getCompanionStatus();
      setStatus(next);
      setStatusError(undefined);
      if (!workspaceTouchedRef.current) setWorkspaceDraft(next.cwd ?? "");
      return next;
    } catch (error) {
      if (isCompanionUnavailableError(error)) {
        onUnavailable();
        return undefined;
      }
      setStatusError(describeError(error));
      return undefined;
    }
  }, [api, onUnavailable]);

  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (!active) return;
      readStatus().catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, COMPANION_STATUS_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [readStatus]);

  const availability = getCompanionActionAvailability(status, busy !== undefined);
  const enrolled = status?.enrolled === true;
  const workspaceIssue = describeCompanionWorkspaceDraft(workspaceDraft);
  const enrollWorkspaceIssue = describeCompanionWorkspaceDraft(enrollWorkspace);

  async function runAction(action: CompanionAction, body?: unknown): Promise<void> {
    if (busyRef.current !== undefined) return;
    const presentation = describeCompanionAction(action);
    if (presentation.confirm !== undefined && !window.confirm(presentation.confirm)) return;
    busyRef.current = action;
    setBusy(action);
    try {
      await api.runCompanionAction(action, body);
      if (action === "enroll") {
        setPairingCode("");
        setEnrollWorkspace("");
      }
      if (action === "workspace") workspaceTouchedRef.current = false;
      onToast({ tone: "success", message: `${presentation.label}已完成。` });
    } catch (error) {
      if (isCompanionUnavailableError(error)) {
        onUnavailable();
        return;
      }
      onToast({ tone: "warning", message: describeError(error) });
    } finally {
      busyRef.current = undefined;
      setBusy(undefined);
      setDoctor(undefined);
      await readStatus();
    }
  }

  async function runDoctor(): Promise<void> {
    setDoctorLoading(true);
    try {
      setDoctor(await api.getCompanionDoctor());
      await readStatus();
    } catch (error) {
      onToast({ tone: "warning", message: describeError(error) });
    } finally {
      setDoctorLoading(false);
    }
  }

  return (
    <section className="companion-panel" aria-labelledby="companion-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">COMPANION HOST</p>
          <h2 id="companion-title">Companion 管理</h2>
        </div>
        <button
          type="button"
          className="icon-button refresh-button"
          aria-label="刷新 Companion 状态"
          title="刷新 Companion 状态"
          disabled={busy !== undefined}
          onClick={() => {
            readStatus().catch(() => undefined);
          }}
        >
          ↻
        </button>
      </div>
      <p className="section-description">
        管理本机 Companion Host：设备绑定、开机自启服务与运行状态。Companion 不监听任何端口，
        仅通过官方 Relay 与你的远程会话建立出站连接。
      </p>

      {busy !== undefined && (
        <div className="companion-busy" role="status">
          <span className="loading-bar" />
          <span>{describeCompanionAction(busy).progress}</span>
        </div>
      )}

      {statusError !== undefined && (
        <div className="companion-error" role="alert">
          <strong>状态读取失败</strong>
          <span>{statusError}</span>
          <small>2 秒后会自动重试。</small>
        </div>
      )}

      <CompanionStatusCard status={status} />

      {status !== undefined && !enrolled && (
        <form
          className="companion-enroll"
          onSubmit={(event) => {
            event.preventDefault();
            runAction("enroll", {
              pairingCode,
              workspace: enrollWorkspace.trim(),
            }).catch(() => undefined);
          }}
        >
          <h3>绑定这台设备</h3>
          <p>
            在 Roll 云端控制台生成一次性配对码，粘贴到下方完成绑定。配对码只在本机内存中停留，
            不会写入日志或配置文件。
          </p>
          <label className="companion-field">
            <span>配对码</span>
            <input
              type="password"
              name="companion-pairing-code"
              autoComplete="off"
              spellCheck={false}
              value={pairingCode}
              placeholder="粘贴一次性配对码"
              onChange={(event) => setPairingCode(event.target.value)}
            />
          </label>
          <label className="companion-field">
            <span>Workspace 绝对路径</span>
            <input
              type="text"
              name="companion-enroll-workspace"
              autoComplete="off"
              spellCheck={false}
              value={enrollWorkspace}
              placeholder="/Users/you/projects/your-app"
              onChange={(event) => setEnrollWorkspace(event.target.value)}
            />
          </label>
          <p className="companion-hint">
            浏览器无法读取本机目录的绝对路径，请手动粘贴。远程会话中的所有命令都会在该目录下执行。
          </p>
          {enrollWorkspace.length > 0 && enrollWorkspaceIssue !== undefined && (
            <p className="companion-issue">{enrollWorkspaceIssue}</p>
          )}
          <button
            type="submit"
            className="primary-button"
            disabled={
              !availability.enroll || pairingCode.length === 0 || enrollWorkspaceIssue !== undefined
            }
          >
            {describeCompanionAction("enroll").label}
          </button>
        </form>
      )}

      {enrolled && (
        <>
          <div className="companion-actions">
            {LIFECYCLE_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                className={
                  action === "unenroll" || action === "service-uninstall"
                    ? "secondary-button danger-action"
                    : "secondary-button"
                }
                disabled={!availability[action]}
                onClick={() => {
                  runAction(action).catch(() => undefined);
                }}
              >
                {describeCompanionAction(action).label}
              </button>
            ))}
          </div>

          <div className="companion-workspace">
            <label className="companion-field">
              <span>Workspace 绝对路径</span>
              <input
                type="text"
                name="companion-workspace"
                autoComplete="off"
                spellCheck={false}
                value={workspaceDraft}
                onChange={(event) => {
                  workspaceTouchedRef.current = true;
                  setWorkspaceDraft(event.target.value);
                }}
              />
            </label>
            {workspaceIssue !== undefined && <p className="companion-issue">{workspaceIssue}</p>}
            <button
              type="button"
              className="secondary-button"
              disabled={
                !availability.workspace ||
                workspaceIssue !== undefined ||
                workspaceDraft.trim() === (status?.cwd ?? "")
              }
              onClick={() => {
                runAction("workspace", { workspace: workspaceDraft.trim() }).catch(() => undefined);
              }}
            >
              {describeCompanionAction("workspace").label}
            </button>
          </div>
        </>
      )}

      <CompanionDoctorPanel
        result={doctor}
        loading={doctorLoading}
        disabled={busy !== undefined}
        onRun={() => {
          runDoctor().catch(() => undefined);
        }}
      />

      <CompanionLogsPanel api={api} onToast={onToast} />
    </section>
  );
}

function CompanionStatusCard({ status }: { readonly status: CompanionStatus | undefined }) {
  if (status === undefined) {
    return (
      <div className="status-loading" role="status">
        <span className="loading-bar" />
        <span className="loading-bar" />
        <span className="sr-only">正在读取 Companion 状态</span>
      </div>
    );
  }
  const phase =
    status.environmentDiagnostics?.blocking === true && !status.runtimeOnline
      ? { label: "需要处理配置", tone: "warn" }
      : describeCompanionPhase(status.phase);
  return (
    <article className="companion-status-card">
      <div className="companion-status-topline">
        <span className={`status-dot ${phase.tone}`} aria-hidden="true" />
        <strong>Companion Host</strong>
        <span className={`companion-phase ${phase.tone}`}>{phase.label}</span>
      </div>
      <div className="companion-status-grid">
        <span>设备绑定</span>
        <code>{status.enrolled ? "已绑定" : "未绑定"}</code>
        <span>启用</span>
        <code>{status.enabled ? "已启用" : "已停用"}</code>
        <span>RUNTIME</span>
        <code>{status.runtimeOnline ? "在线" : "离线"}</code>
        <span>RELAY 通道</span>
        <code>官方内置 · {status.relayProfile}</code>
        {status.cwd !== undefined && (
          <>
            <span>WORKSPACE</span>
            <code>{status.cwd}</code>
          </>
        )}
        {status.deviceId !== undefined && (
          <>
            <span>DEVICE</span>
            <code>{status.deviceId}</code>
          </>
        )}
      </div>
      {status.lastError !== undefined && status.environmentDiagnostics?.blocking !== true && (
        <p className="companion-last-error">{status.lastError}</p>
      )}
      {status.environmentDiagnostics !== undefined && (
        <CompanionEnvironmentDiagnostics report={status.environmentDiagnostics} />
      )}
    </article>
  );
}

export function CompanionEnvironmentDiagnostics({
  report,
}: {
  readonly report: EnvironmentDiagnostics;
}) {
  return (
    <section className="companion-doctor" aria-label="后台运行环境诊断">
      <h4>
        {report.blocking
          ? "后台运行环境配置需要处理"
          : report.issues.length > 0
            ? "部分配置需要检查"
            : "配置引用检查通过"}
      </h4>
      <p>
        {report.environment === "service"
          ? "已按 Companion 进程的实际环境检查。此检查不验证模型或其他远端服务的凭据是否有效。"
          : "当前为后台环境预检估算，尚未验证实际服务环境。终端中的环境变量不一定在后台可用。"}
      </p>
      {report.configPath !== undefined && (
        <p>
          配置文件：<code>{report.configPath}</code>
        </p>
      )}
      <ul className="companion-check-list">
        {report.issues.map((issue, index) => (
          <li key={`${issue.code}:${issue.variable ?? index}`} className="warn">
            <div>
              <strong>
                {issue.severity === "error" ? "启动阻断" : "配置提醒"} · {issue.message}
              </strong>
              {issue.variable !== undefined && (
                <p>
                  环境变量：<code>{issue.variable}</code>
                </p>
              )}
              {issue.paths.length > 0 && (
                <p>
                  引用位置：
                  {issue.paths.map((path) => (
                    <code key={path}>{path} </code>
                  ))}
                </p>
              )}
              <p>{issue.remedy}</p>
            </div>
          </li>
        ))}
      </ul>
      {report.truncated && <p>问题较多，当前仅显示部分项目；处理后请重新检查。</p>}
      {report.issues.length > 0 && (
        <p>补齐配置后可使用“刷新 Companion 状态”重新检查，使用“重启”让 Runtime 重新加载配置。</p>
      )}
    </section>
  );
}

function CompanionDoctorPanel({
  result,
  loading,
  disabled,
  onRun,
}: {
  readonly result: CompanionDoctorResult | undefined;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onRun: () => void;
}) {
  return (
    <section className="companion-doctor" aria-labelledby="companion-doctor-title">
      <div className="panel-heading-row">
        <div>
          <p className="eyebrow">DIAGNOSTICS</p>
          <h3 id="companion-doctor-title">环境体检</h3>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || loading}
          onClick={onRun}
        >
          {loading ? "体检中…" : "运行体检"}
        </button>
      </div>
      {result === undefined ? (
        <p className="empty-inline">尚未运行体检。</p>
      ) : (
        <ul className="companion-check-list">
          {result.checks.map((check) => (
            <li key={check.name} className={check.ok ? "ok" : "warn"}>
              <span className={`status-dot ${check.ok ? "ok" : "warn"}`} aria-hidden="true" />
              <div>
                <strong>{check.name}</strong>
                <small>{check.detail}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
