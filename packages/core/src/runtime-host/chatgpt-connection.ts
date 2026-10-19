import { ChatGptAuthError, isTemporaryChatGptError } from "../auth/chatgpt/errors.ts";
import type { ChatGptAuth, ChatGptModels } from "./chatgpt-resolution.ts";

/** UI connectivity and catalog validation, independent of local session/history lifetime. */
export class ChatGptConnection {
  private readonly auth: ChatGptAuth;
  private account: string | undefined;
  private catalog: ChatGptModels;
  private message = "ChatGPT 尚未连接；本地会话可用，正在准备连接。";
  private ready = false;
  private enabled = true;
  private disposed = false;
  private pending: Promise<void> | undefined;
  private failure: { error: unknown } | undefined;
  private readonly timeoutMs: number;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();

  constructor(
    auth: ChatGptAuth,
    accountId: string | undefined,
    models: ChatGptModels,
    timeoutMs = 15_000,
  ) {
    this.auth = auth;
    this.account = accountId;
    this.catalog = models;
    this.timeoutMs = timeoutMs;
  }

  get accountId(): string | undefined {
    return this.account;
  }
  get models(): ChatGptModels {
    return this.catalog;
  }
  updateCatalog(models: ChatGptModels, accountId: string | undefined): void {
    this.account ??= accountId;
    if (accountId === this.account) this.catalog = models;
  }
  getSnapshot = (): string => (this.enabled ? this.message : "");
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(message: string): void {
    this.message = message;
    for (const listener of this.listeners) listener();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.publish(this.message);
  }

  start = (): void => {
    if (!this.ready && !this.pending && !this.disposed && this.enabled) {
      this.ensure().catch(() => {});
    }
  };

  retry = async (): Promise<void> => {
    if (!this.enabled || this.disposed) return;
    this.ready = false;
    this.failure = undefined;
    await this.ensure();
  };

  /** A new user submission may retry; the model call in that same turn must not replay preflight. */
  async prepare(signal?: AbortSignal): Promise<void> {
    if (!this.pending) this.failure = undefined;
    await this.ensure(signal);
  }

  failed(error: unknown): void {
    this.ready = false;
    this.failure = { error };
    if (this.disposed) return;
    const message =
      error instanceof ChatGptAuthError
        ? error.message
        : "ChatGPT 连接暂不可用，请检查网络或账号状态。";
    this.publish(`${message} 本地会话和输入已保留；/reconnect 重试连接。`);
  }

  async ensure(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.ready) return;
    if (this.failure) throw this.failure.error;
    if (!this.pending) {
      const requestSignal = AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(this.timeoutMs),
        ...(signal ? [signal] : []),
      ]);
      this.publish("正在连接 ChatGPT；网络波动将自动重试，本地会话和输入可继续使用。");
      const operation = (async () => {
        if (!this.account) this.account = (await this.auth.status()).currentAccountId;
        if (!this.account) {
          throw new ChatGptAuthError(
            "login_required",
            "尚未登录 ChatGPT，请在另一个终端运行 roll auth chatgpt login，完成后重试连接。",
          );
        }
        const catalog = await this.auth.models(this.account, requestSignal);
        requestSignal.throwIfAborted();
        this.catalog = catalog;
        this.ready = true;
        this.failure = undefined;
        this.publish("ChatGPT 已连接；可继续发送消息，/model 查看可用模型。");
      })();
      this.pending = waitForConnection(operation, requestSignal)
        .catch((error: unknown) => {
          this.failed(error);
          throw error;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    // Cancelling a turn stops waiting without cancelling an independently started background check.
    await waitForConnection(this.pending, signal);
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    await this.ensure(signal);
    try {
      return await this.auth.getAccessToken(this.account, signal);
    } catch (error) {
      if (!signal?.aborted) this.failed(error);
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    this.listeners.clear();
  }
}

function waitForConnection(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export type ChatConnection = Pick<
  ChatGptConnection,
  "getSnapshot" | "subscribe" | "start" | "retry"
>;

/** Safe text for UI surfaces; never render arbitrary request errors containing credentials. */
export function chatGptConnectionError(error: unknown): string {
  if (error instanceof ChatGptAuthError) {
    return `${error.message}${isTemporaryChatGptError(error) ? " 可输入 /reconnect 重试连接。" : ""}`;
  }
  return "ChatGPT 连接失败，请检查网络后输入 /reconnect 重试连接。";
}
