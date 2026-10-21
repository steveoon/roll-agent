import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";
import { chatGptErrorPresentation } from "./chatgpt-error-presentation.ts";
import type { ChatGptAuth, ChatGptModels } from "./chatgpt-resolution.ts";

export const CHAT_CONNECTION_STATES = {
  idle: "idle",
  connecting: "connecting",
  connected: "connected",
  failed: "failed",
  disabled: "disabled",
} as const;

export type ChatConnectionState =
  (typeof CHAT_CONNECTION_STATES)[keyof typeof CHAT_CONNECTION_STATES];
export type ChatConnectionSnapshot =
  | { readonly state: Exclude<ChatConnectionState, typeof CHAT_CONNECTION_STATES.failed> }
  | {
      readonly state: typeof CHAT_CONNECTION_STATES.failed;
      readonly message: string;
      readonly reportedInTurn?: boolean;
    };

const DISABLED_SNAPSHOT: ChatConnectionSnapshot = { state: CHAT_CONNECTION_STATES.disabled };

/** UI connectivity and catalog validation, independent of local session/history lifetime. */
export class ChatGptConnection {
  private readonly auth: ChatGptAuth;
  private account: string | undefined;
  private catalog: ChatGptModels;
  private snapshot: ChatConnectionSnapshot = { state: CHAT_CONNECTION_STATES.idle };
  private ready = false;
  private turnOwnsFailure = false;
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
  getSnapshot = (): ChatConnectionSnapshot => (this.enabled ? this.snapshot : DISABLED_SNAPSHOT);
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: ChatConnectionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.publish(this.snapshot);
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

  /** Idempotent: preparation and Runtime refer to the same real user submission. */
  beginTurn(): void {
    this.turnOwnsFailure = true;
    if (this.failure) this.publish({ state: CHAT_CONNECTION_STATES.connecting });
  }

  recovering(): void {
    this.ready = false;
    this.publish({ state: CHAT_CONNECTION_STATES.connecting });
  }

  async prepareRecovery(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.ready = false;
    this.failure = undefined;
    await this.ensure(signal);
  }

  endTurn(error?: unknown): void {
    this.turnOwnsFailure = false;
    if (error !== undefined && chatGptErrorPresentation(error).invalidatesConnection) {
      this.failed(error, true);
    } else if (!this.ready) {
      this.failure = undefined;
      this.publish({ state: CHAT_CONNECTION_STATES.idle });
    }
  }

  failed(error: unknown, reportedInTurn = false): void {
    this.ready = false;
    this.failure = { error };
    if (this.disposed) return;
    if (this.turnOwnsFailure) {
      this.publish({ state: CHAT_CONNECTION_STATES.connecting });
      return;
    }
    this.publish({
      state: CHAT_CONNECTION_STATES.failed,
      message: `输入已保留；${chatGptConnectionError(error)}`,
      ...(reportedInTurn ? { reportedInTurn } : {}),
    });
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
      this.publish({ state: CHAT_CONNECTION_STATES.connecting });
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
        this.publish({ state: CHAT_CONNECTION_STATES.connected });
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
  return chatGptErrorPresentation(error).message;
}
