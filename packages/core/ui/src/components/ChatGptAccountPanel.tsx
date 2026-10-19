import { useEffect, useState } from "react";
import type { RollUiApi } from "../api.ts";
import type { ChatGptModelCatalog } from "../lib/thinking-catalog.ts";

type ChatGptStatus = Awaited<ReturnType<RollUiApi["getChatGptStatus"]>>;
type ChatGptModels = Awaited<ReturnType<RollUiApi["getChatGptModels"]>>;
type LoginProgress = Awaited<ReturnType<RollUiApi["beginChatGptLogin"]>>;

interface ChatGptAccountPanelProps {
  readonly api: RollUiApi;
  readonly accountId?: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly onAccount: (accountId: string) => void;
  readonly onModel: (model: string, accountId: string) => void;
  readonly onModels?: (catalog: ChatGptModelCatalog) => void;
}

const LOGIN_LABELS = {
  waiting: "请在系统浏览器完成 ChatGPT 授权。",
  exchanging: "正在校验授权。",
  succeeded: "登录成功。",
  cancelled: "登录已取消。",
  denied: "授权被拒绝。",
  failed: "登录未完成。",
  "timed-out": "登录超时，请重试。",
} as const;

export function ChatGptAccountPanel({
  api,
  accountId,
  model,
  enabled,
  onAccount,
  onModel,
  onModels,
}: ChatGptAccountPanelProps) {
  const [status, setStatus] = useState<ChatGptStatus>();
  const [models, setModels] = useState<ChatGptModels>([]);
  const [progress, setProgress] = useState<LoginProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [statusRevision, setStatusRevision] = useState(0);
  const [modelsLoading, setModelsLoading] = useState(false);
  const selectedId = accountId ?? status?.currentAccountId;
  const account = status?.accounts.find((item) => item.id === selectedId);
  const loginActive = progress?.state === "waiting" || progress?.state === "exchanging";

  useEffect(() => {
    setNotice(undefined);
    setError(undefined);
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    api.getChatGptStatus().then(
      (value) => {
        if (active) setStatus(value);
      },
      (reason: unknown) => {
        if (active) {
          setError(describeError(reason));
          onModels?.({
            ...(accountId === undefined ? {} : { accountId }),
            models: [],
            status: "unavailable",
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api, statusRevision, accountId, onModels]);

  useEffect(() => {
    let active = true;
    setModels([]);
    onModels?.({
      ...(selectedId === undefined ? {} : { accountId: selectedId }),
      models: [],
      status:
        status === undefined || (account?.connected === true && account.authorized === true)
          ? "loading"
          : "unavailable",
    });
    setModelsLoading(false);
    if (selectedId === undefined || account?.connected !== true || account.authorized !== true) {
      return;
    }
    setModelsLoading(true);
    api
      .getChatGptModels(selectedId)
      .then(
        (value) => {
          if (active) {
            setModels(value);
            onModels?.({ accountId: selectedId, models: value, status: "ready" });
            setError(undefined);
          }
        },
        (reason: unknown) => {
          if (active) {
            setError(describeError(reason));
            onModels?.({ accountId: selectedId, models: [], status: "unavailable" });
          }
        },
      )
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    api,
    selectedId,
    account?.connected,
    account?.authorized,
    status === undefined,
    statusRevision,
    onModels,
  ]);

  useEffect(() => {
    if (progress === undefined || !loginActive) return;
    let active = true;
    const timer = window.setTimeout(() => {
      api.getChatGptLoginStatus(progress.id).then(
        (value) => {
          if (!active) return;
          setProgress(value);
          if (value.state !== "waiting" && value.state !== "exchanging") {
            setStatusRevision((current) => current + 1);
          }
        },
        (reason: unknown) => {
          if (active) {
            setError(describeError(reason));
            setProgress(undefined);
          }
        },
      );
    }, 1000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, progress, loginActive]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }

  const selectedModel = models.find((item) => item.slug === model);
  const connectionLabel =
    account === undefined
      ? "未连接"
      : !account.connected
        ? "需登录"
        : account.authorized
          ? "已授权"
          : "需授权";

  return (
    <section className="chatgpt-account-panel" aria-label="ChatGPT 订阅账号">
      <header className="chatgpt-panel-header">
        <div className="chatgpt-panel-copy">
          <div className="chatgpt-title-row">
            <h2>ChatGPT 订阅</h2>
            <span className="section-count">实验功能</span>
          </div>
          <p>连接你的订阅账号，为聊天与定时任务选择模型。</p>
        </div>
        {account?.connected === true && (
          <button
            type="button"
            className="secondary-button chatgpt-quiet-button"
            disabled={busy || loginActive}
            onClick={() => {
              run(async () => {
                setProgress(await api.beginChatGptLogin());
              });
            }}
          >
            <span aria-hidden="true">＋</span> 添加账号
          </button>
        )}
      </header>

      {status !== undefined && account?.connected !== true && (
        <div className="chatgpt-connect">
          <div>
            <strong>连接 ChatGPT</strong>
            <p>在系统浏览器完成登录，并授权使用订阅用量。</p>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={busy || loginActive}
            onClick={() => {
              run(async () => {
                setProgress(await api.beginChatGptLogin());
              });
            }}
          >
            Continue with ChatGPT
          </button>
        </div>
      )}

      {progress !== undefined && (
        <div className="chatgpt-feedback" role="status">
          <span>{progress.message ?? LOGIN_LABELS[progress.state]}</span>
          {loginActive && (
            <button
              type="button"
              className="secondary-button chatgpt-quiet-button"
              disabled={busy}
              onClick={() => {
                run(async () => {
                  setProgress(await api.cancelChatGptLogin(progress.id));
                });
              }}
            >
              取消登录
            </button>
          )}
        </div>
      )}

      <div className="chatgpt-fields">
        <div className="field-control">
          <div className="chatgpt-field-heading">
            <label htmlFor="chatgpt-account">订阅账号</label>
            <span
              className={`chatgpt-connection ${account?.connected && account.authorized ? "is-ready" : ""}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {status === undefined && error === undefined ? "读取中…" : connectionLabel}
            </span>
          </div>
          <select
            id="chatgpt-account"
            value={selectedId ?? ""}
            disabled={busy || loginActive || status === undefined || status.accounts.length === 0}
            onChange={(event) => {
              setProgress(undefined);
              onAccount(event.target.value);
            }}
            aria-describedby="chatgpt-account-note"
          >
            <option value="" disabled>
              {status === undefined ? "正在读取账号…" : "请先连接 ChatGPT 账号"}
            </option>
            {accountId !== undefined && account === undefined && (
              <option value={accountId}>
                {accountId.slice(0, 8)}（{status === undefined ? "读取中…" : "未登录"}）
              </option>
            )}
            {status?.accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <p className="chatgpt-field-note" id="chatgpt-account-note">
            {status === undefined
              ? "正在检查连接与授权…"
              : account?.connected
                ? account.authorized
                  ? "已允许 Roll 使用订阅用量"
                  : "尚未授权订阅用量，请在账号管理中重新授权"
                : "登录授权后，可选择此账号的订阅模型"}
          </p>
        </div>

        <div className="field-control">
          <div className="chatgpt-field-heading">
            <label htmlFor="chatgpt-model">默认模型</label>
            <button
              type="button"
              className="chatgpt-refresh-button"
              disabled={busy || loginActive || modelsLoading}
              aria-label="更新状态和模型"
              title="更新状态和模型"
              onClick={() => {
                setProgress(undefined);
                setStatusRevision((current) => current + 1);
              }}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
          <select
            id="chatgpt-model"
            value={enabled ? (model ?? "") : ""}
            disabled={busy || loginActive || modelsLoading || models.length === 0}
            onChange={(event) => {
              if (selectedId !== undefined) onModel(event.target.value, selectedId);
            }}
            aria-describedby="chatgpt-model-note"
          >
            <option value="" disabled>
              {modelsLoading
                ? "正在获取可用模型…"
                : models.length === 0
                  ? "连接并授权账号后选择"
                  : "选择默认模型"}
            </option>
            {enabled && model !== undefined && !models.some((item) => item.slug === model) && (
              <option value={model}>
                {model}（{modelsLoading || status === undefined ? "读取中…" : "当前不可用"}）
              </option>
            )}
            {models.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.displayName}
              </option>
            ))}
          </select>
          <p className="chatgpt-field-note" id="chatgpt-model-note">
            {modelsLoading || status === undefined ? (
              "正在读取所选账号的可用模型…"
            ) : enabled && selectedModel !== undefined ? (
              <>
                模型 ID <code>{selectedModel.slug}</code>
              </>
            ) : (
              "可用模型由所选账号提供"
            )}
          </p>
        </div>
      </div>

      <div className="chatgpt-save-note">
        <span>账号与模型需审阅并保存，下次聊天及定时任务生效。</span>
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
          管理用量 <span aria-hidden="true">↗</span>
        </a>
      </div>
      {enabled && (
        <p className="chatgpt-feedback" role="alert">
          保存后，聊天与定时任务共用此订阅模型。Runtime 服务和 Companion 暂不支持此配置，需要使用
          API Key provider；roll ask 仍使用独立的 API Key 配置。
        </p>
      )}

      {account !== undefined && (
        <details className="chatgpt-management">
          <summary>账号管理</summary>
          <div className="chatgpt-management-body">
            <div className="chatgpt-management-actions">
              <button
                type="button"
                className="secondary-button chatgpt-quiet-button"
                disabled={busy || loginActive}
                onClick={() => {
                  run(async () => {
                    setProgress(await api.beginChatGptLogin(selectedId));
                  });
                }}
              >
                重新授权此账号
              </button>
              <button
                type="button"
                className="secondary-button chatgpt-quiet-button"
                disabled={busy || loginActive || account.connected !== true}
                onClick={() => {
                  run(async () => {
                    const result = await api.refreshChatGpt(selectedId);
                    setProgress(undefined);
                    setNotice(result.refreshed ? "凭证已刷新。" : "已使用其他进程刷新的凭证。");
                    setStatusRevision((current) => current + 1);
                  });
                }}
              >
                刷新凭证
              </button>
              <button
                type="button"
                className="secondary-button chatgpt-quiet-button chatgpt-signout-button"
                disabled={busy || loginActive || account.connected !== true}
                onClick={() => {
                  run(async () => {
                    const result = await api.logoutChatGpt(selectedId);
                    setProgress(undefined);
                    setNotice(
                      result.revocationConfirmed
                        ? "已撤销远端授权并退出。"
                        : "已清除本地凭证；远端撤销尚未确认。请前往 ChatGPT 管理用量和授权。",
                    );
                    setStatusRevision((current) => current + 1);
                  });
                }}
              >
                退出账号
              </button>
            </div>
            {account.expiresAt !== undefined && (
              <p className="chatgpt-field-note">
                凭证有效至{" "}
                <time dateTime={new Date(account.expiresAt).toISOString()}>
                  {new Date(account.expiresAt).toLocaleString()}
                </time>
              </p>
            )}
          </div>
        </details>
      )}
      {notice !== undefined && (
        <p className="chatgpt-feedback" role="status">
          {notice}
        </p>
      )}
      {error !== undefined && (
        <p className="chatgpt-feedback is-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "ChatGPT 操作未完成，请重试。";
}
