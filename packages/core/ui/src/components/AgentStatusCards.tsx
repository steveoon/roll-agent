import type { AgentRuntimeStatus } from "../types.ts";

export interface AgentStatusCardsProps {
  readonly agents: readonly AgentRuntimeStatus[];
  readonly loading: boolean;
  readonly error?: string;
  readonly checkedAt?: string;
  readonly onRefresh: () => void;
}

export function AgentStatusCards({
  agents,
  loading,
  error,
  checkedAt,
  onRefresh,
}: AgentStatusCardsProps) {
  return (
    <section className="agent-status-section" aria-labelledby="agent-status-title">
      <div className="panel-heading-row">
        <div>
          <p className="eyebrow">RUNTIME PULSE</p>
          <h2 id="agent-status-title">Agent 状态</h2>
        </div>
        <button
          type="button"
          className="icon-button refresh-button"
          aria-label="刷新 Agent 状态"
          title="刷新 Agent 状态"
          disabled={loading}
          onClick={onRefresh}
        >
          ↻
        </button>
      </div>
      {checkedAt !== undefined && <p className="checked-time">CHECKED {formatTime(checkedAt)}</p>}
      {error !== undefined && (
        <div className="agent-status-error" role="alert">
          <strong>状态读取失败</strong>
          <span>{error}</span>
          <small>
            {agents.length > 0 ? "下方保留最近一次成功结果。" : "请检查 Agent 服务后重试。"}
          </small>
        </div>
      )}
      <div className="agent-card-list">
        {agents.length === 0 && !loading && error === undefined && (
          <div className="empty-inline">暂无已注册 Agent。</div>
        )}
        {agents.map((agent) => (
          <article className="agent-card" key={agent.name}>
            <div className="agent-card-topline">
              <span className={`status-dot ${statusTone(agent)}`} aria-hidden="true" />
              <strong>{agent.name}</strong>
              <span className={`agent-state ${statusTone(agent)}`}>{agent.status}</span>
            </div>
            <div className="agent-card-grid">
              <span>OWNER</span>
              <code>{formatOwnership(agent.ownership)}</code>
              {agent.pid !== undefined && (
                <>
                  <span>PID</span>
                  <code>{agent.pid}</code>
                </>
              )}
              {agent.endpoint !== undefined && (
                <>
                  <span>ENDPOINT</span>
                  <code>{agent.endpoint}</code>
                </>
              )}
              {agent.browserRunning !== undefined && (
                <>
                  <span>BROWSER</span>
                  <code>{agent.browserRunning ? "running" : "lazy / stopped"}</code>
                </>
              )}
            </div>
            {agent.detail !== undefined && <p>{agent.detail}</p>}
            {agent.lastError !== undefined && <p className="agent-error">{agent.lastError}</p>}
          </article>
        ))}
        {loading && (
          <div className="status-loading" role="status">
            <span className="loading-bar" />
            <span className="loading-bar" />
            <span className="loading-bar" />
            <span className="sr-only">正在读取 Agent 状态</span>
          </div>
        )}
      </div>
    </section>
  );
}

function statusTone(agent: AgentRuntimeStatus): "ok" | "warn" | "off" {
  if (agent.healthy === true || agent.status === "online") return "ok";
  if (agent.status === "starting" || agent.status === "error") return "warn";
  return "off";
}

function formatOwnership(ownership: AgentRuntimeStatus["ownership"]): string {
  switch (ownership) {
    case "core-managed":
      return "core";
    case "external-managed":
      return "external";
    case "on-demand":
      return "on demand";
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false });
}
