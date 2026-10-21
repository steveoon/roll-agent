import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod/v4";
import {
  chatGptStatusSchema,
  chatGptLoginProgressSchema,
  type ChatGptStatus,
  type ChatGptModel,
  type ChatGptLoginProgress,
  type ChatGptCredential,
  type ChatGptRegistration,
  type ChatGptRefreshResult,
  type ChatGptLogoutResult,
} from "./schemas.ts";
import { ChatGptCredentialStore } from "./storage.ts";
import { ChatGptAuthError, isTemporaryChatGptError } from "./errors.ts";
import { readChatGptResponse } from "./request.ts";
import { readChatGptModelCache, writeChatGptModelCache } from "./model-cache.ts";
export { ChatGptAuthError } from "./errors.ts";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const REQUESTED_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_id_token",
  "invalid_token_response",
  "invalid_refresh_time",
]);
const metadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
});
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  earliest_refresh_at: z
    .union([z.number().nonnegative(), z.string().datetime({ offset: true })])
    .optional(),
});
const modelResponseSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().min(1),
      visibility: z.string(),
      context_window: z.number().int().positive().optional(),
      supported_reasoning_levels: z.array(z.object({ effort: z.string().min(1) })).optional(),
    }),
  ),
});
const jwksSchema = z.object({ keys: z.array(z.object({ kty: z.string() }).passthrough()) });
const errorCodeSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);

export type ChatGptAuthServiceOptions = {
  directory?: string;
  store?: ChatGptCredentialStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  openBrowser?: (url: string) => Promise<void>;
  issuer?: string;
  apiBaseUrl?: string;
  loginTimeoutMs?: number;
};

type LoginAttempt = {
  progress: ChatGptLoginProgress;
  server: Server;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
};

export class ChatGptAuthService {
  private readonly store: ChatGptCredentialStore;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly issuer: string;
  private readonly apiBaseUrl: string;
  private readonly loginTimeoutMs: number;
  private metadataValue: z.infer<typeof metadataSchema> | undefined;
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(options: ChatGptAuthServiceOptions = {}) {
    this.store =
      options.store ??
      new ChatGptCredentialStore(
        options.directory ?? resolve(homedir(), ".roll-agent", "auth", "chatgpt"),
      );
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.openBrowser = options.openBrowser ?? openSystemBrowser;
    this.issuer = options.issuer ?? ISSUER;
    this.apiBaseUrl = options.apiBaseUrl ?? RESOURCE;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000;
  }

  async status(accountId?: string): Promise<ChatGptStatus> {
    const currentAccountId = accountId ?? this.store.readHost()?.currentAccountId;
    if (accountId !== undefined) this.requireRegistration(accountId);
    return chatGptStatusSchema.parse({
      ...(currentAccountId === undefined ? {} : { currentAccountId }),
      usageUrl: "https://chatgpt.com/settings/usage",
      accounts: this.store.list().map((profile) => ({
        id: profile.id,
        label: `${profile.email ?? "ChatGPT"} · ${profile.id.slice(0, 8)}`,
        ...(profile.email === undefined ? {} : { email: profile.email }),
        connected: profile.credentials !== undefined,
        authorized: profile.credentials?.scopes.includes(DIRECT_SCOPE) ?? false,
        ...(profile.credentials === undefined
          ? {}
          : {
              expiresAt: profile.credentials.expiresAt,
              ...(profile.credentials.earliestRefreshAt === undefined
                ? {}
                : { earliestRefreshAt: profile.credentials.earliestRefreshAt }),
            }),
      })),
    });
  }

  cachedModels(accountId?: string): ChatGptModel[] {
    const id = accountId ?? this.store.readHost()?.currentAccountId;
    const profile = id === undefined ? undefined : this.store.read(id);
    return profile ? readChatGptModelCache(this.store.directory, profile, this.now()) : [];
  }

  async models(accountId?: string, signal?: AbortSignal): Promise<ChatGptModel[]> {
    const id = this.resolveAccountId(accountId);
    const token = await this.getAccessToken(id, signal);
    const response = await readChatGptResponse(this.fetch, `${this.apiBaseUrl}/models`, "models", {
      headers: { Authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await this.responseError(response, "models_failed");
    const catalog = modelResponseSchema.parse(await response.json());
    const models = catalog.models
      .filter((model) => model.visibility === "list")
      .map((model) => ({
        slug: model.slug,
        displayName: model.display_name,
        ...(model.context_window === undefined ? {} : { contextWindow: model.context_window }),
        ...(model.supported_reasoning_levels === undefined
          ? {}
          : { reasoningEfforts: model.supported_reasoning_levels.map(({ effort }) => effort) }),
      }));
    writeChatGptModelCache(this.store.directory, this.requireRegistration(id), models, this.now());
    return models;
  }

  async getAccessToken(accountId?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let profile = this.requireRegistration(this.resolveAccountId(accountId));
    let credentials = this.requireCredentials(profile);
    if (!credentials.scopes.includes(DIRECT_SCOPE)) {
      throw new ChatGptAuthError(
        "scope_not_authorized",
        "此账号尚未授权 ChatGPT 订阅用量，请通过登录授权开启。",
      );
    }
    if (credentials.expiresAt <= this.now() + 60_000 && this.canRefresh(credentials)) {
      try {
        await this.refresh(profile.id, signal);
      } catch (error) {
        // A pre-expiry renewal outage must not reject a still-valid access token.
        // Re-read after the failed renewal: terminal errors may have cleared it,
        // or another process may already have persisted a replacement.
        const latest = this.requireCredentials(this.requireRegistration(profile.id));
        const temporary = isTemporaryChatGptError(error);
        if (!temporary || latest.expiresAt <= this.now()) throw error;
      }
      profile = this.requireRegistration(profile.id);
      credentials = this.requireCredentials(profile);
    }
    if (!credentials.scopes.includes(DIRECT_SCOPE)) {
      throw new ChatGptAuthError(
        "scope_not_authorized",
        "此账号尚未授权 ChatGPT 订阅用量，请通过登录授权开启。",
      );
    }
    if (credentials.expiresAt <= this.now()) {
      throw new ChatGptAuthError(
        "token_expired",
        "ChatGPT token 已过期；请在服务端允许续期后刷新，或重新登录。",
      );
    }
    return credentials.accessToken;
  }

  async beginLogin(accountId?: string): Promise<ChatGptLoginProgress> {
    const selected = accountId === undefined ? undefined : this.requireRegistration(accountId);
    const hostId = await this.store.hostId();
    const metadata = await this.metadata();
    const id = randomUUID();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new ChatGptAuthError("callback_unavailable", "无法创建 ChatGPT 本地回调。");
    }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const attempt: LoginAttempt = {
      progress: { id, state: "waiting" },
      server,
      abort: new AbortController(),
      timer: setTimeout(
        () => this.finishAttempt(id, "timed-out", "登录超时，请重试。"),
        this.loginTimeoutMs,
      ),
    };
    this.attempts.set(id, attempt);
    this.pruneAttempts();
    server.on("request", (request, response) => {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      let callback: URL;
      try {
        callback = new URL(request.url ?? "/", redirectUri);
      } catch {
        response.statusCode = 400;
        response.end("无效的 ChatGPT 登录回调地址。");
        return;
      }
      if (
        request.method !== "GET" ||
        callback.origin !== new URL(redirectUri).origin ||
        callback.pathname !== "/auth/callback" ||
        callback.searchParams.get("state") !== state ||
        attempt.progress.state !== "waiting"
      ) {
        response.statusCode = 400;
        response.end("无效或已结束的 ChatGPT 登录回调。");
        return;
      }
      const oauthError = callback.searchParams.get("error");
      if (oauthError !== null) {
        this.finishAttempt(
          id,
          oauthError === "access_denied" ? "denied" : "failed",
          "ChatGPT 登录未获授权。",
        );
        response.end("登录未完成。可以关闭此窗口并返回 Roll。");
        return;
      }
      const code = callback.searchParams.get("code");
      const clientId = callback.searchParams.get("client_id") ?? selected?.clientId;
      if (
        !code ||
        !clientId ||
        clientId === "dynamic_agent_client" ||
        (selected !== undefined && clientId !== selected.clientId)
      ) {
        this.finishAttempt(id, "failed", "ChatGPT 注册回调缺少或不匹配 client ID。");
        response.statusCode = 400;
        response.end("注册未完成。请返回 Roll 重新登录。");
        return;
      }
      attempt.progress = { id, state: "exchanging" };
      response.end("正在完成授权。可以关闭此窗口并返回 Roll。");
      this.completeLogin(attempt, {
        accountId: selected?.id ?? randomUUID(),
        clientId,
        hostId,
        nonce,
        code,
        verifier,
        redirectUri,
      });
    });
    const authorization = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: selected?.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: REQUESTED_SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    })) {
      authorization.searchParams.set(key, value);
    }
    if (selected === undefined) authorization.searchParams.set("agent_name_hint", "Roll");
    else {
      if (selected.credentials?.idToken) {
        authorization.searchParams.set("id_token_hint", selected.credentials.idToken);
      }
      if (selected.email) authorization.searchParams.set("login_hint", selected.email);
      if (!(selected.credentials?.scopes.includes(DIRECT_SCOPE) ?? false)) {
        authorization.searchParams.set("prompt", "consent");
      }
    }
    try {
      await this.openBrowser(authorization.href);
    } catch {
      this.finishAttempt(id, "failed", "系统浏览器未能打开，请检查本机浏览器设置并重试。");
    }
    return this.loginStatus(id);
  }

  loginStatus(id: string): ChatGptLoginProgress {
    const attempt = this.attempts.get(id);
    if (!attempt) {
      throw new ChatGptAuthError("login_not_found", "此登录操作不存在或已过期，请重新发起登录。");
    }
    return chatGptLoginProgressSchema.parse(attempt.progress);
  }

  cancelLogin(id: string): ChatGptLoginProgress {
    const progress = this.loginStatus(id);
    if (progress.state === "waiting" || progress.state === "exchanging") {
      this.finishAttempt(id, "cancelled", "已取消登录。");
    }
    return this.loginStatus(id);
  }

  async refresh(accountId?: string, signal?: AbortSignal): Promise<ChatGptRefreshResult> {
    const id = this.resolveAccountId(accountId);
    const before = this.requireCredentials(this.requireRegistration(id));
    return this.store.withLock(
      id,
      async () => {
        signal?.throwIfAborted();
        const profile = this.requireRegistration(id);
        const credentials = this.requireCredentials(profile);
        if (credentials.refreshToken !== before.refreshToken) {
          return {
            accountId: id,
            refreshed: false,
            ...(credentials.earliestRefreshAt === undefined
              ? {}
              : { earliestRefreshAt: credentials.earliestRefreshAt }),
          };
        }
        if (!this.canRefresh(credentials)) {
          throw new ChatGptAuthError(
            "refresh_too_early",
            `服务端尚未允许刷新，请在 ${new Date(credentials.earliestRefreshAt ?? 0).toISOString()} 后重试。`,
          );
        }
        try {
          // Load trusted signing keys before consuming a rotating refresh token. A temporary
          // JWKS outage must not strand a replacement token after the old one is consumed.
          const verificationKeys = await this.identityKeys(signal);
          // Cancellation is safe until dispatch. Once sent, finish receiving and saving
          // the replacement under the account lock even if the caller stops waiting.
          const token = await this.exchange(
            {
              grant_type: "refresh_token",
              client_id: profile.clientId,
              refresh_token: credentials.refreshToken,
              resource: RESOURCE,
            },
            signal,
            true,
          );
          if (token.id_token !== undefined) {
            await this.validateIdentity(
              token.id_token,
              profile.clientId,
              undefined,
              profile.subject,
              verificationKeys,
            );
          }
          const replacement = this.credentials(token, credentials);
          this.store.save({ ...profile, credentials: replacement });
          return {
            accountId: id,
            refreshed: true,
            ...(replacement.earliestRefreshAt === undefined
              ? {}
              : { earliestRefreshAt: replacement.earliestRefreshAt }),
          };
        } catch (error) {
          if (error instanceof ChatGptAuthError && TERMINAL_REFRESH_ERRORS.has(error.code)) {
            const retained = { ...profile };
            delete retained.credentials;
            this.store.save(retained);
            throw new ChatGptAuthError(
              error.code,
              "ChatGPT 续期凭证已失效，请使用此账号重新登录。",
              error.status,
              error.requestId,
            );
          }
          throw error;
        }
      },
      signal,
    );
  }

  async logout(accountId?: string): Promise<ChatGptLogoutResult> {
    const id = this.resolveAccountId(accountId);
    return this.store.withLock(id, async () => {
      const profile = this.requireRegistration(id);
      let revocationConfirmed = profile.credentials === undefined;
      if (profile.credentials !== undefined) {
        for (let retry = 0; retry < 3; retry += 1) {
          try {
            const endpoint = (await this.metadata()).revocation_endpoint;
            if (endpoint === undefined) break;
            const response = await this.fetch(endpoint, {
              method: "POST",
              body: new URLSearchParams({
                token: profile.credentials.refreshToken,
                token_type_hint: "refresh_token",
                client_id: profile.clientId,
              }),
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              signal: AbortSignal.timeout(10_000),
            });
            if (response.status === 200) {
              revocationConfirmed = true;
              break;
            }
            if (response.status < 500) break;
          } catch {
            /* Local sign-out still completes, with an explicit unconfirmed result. */
          }
          if (retry < 2) {
            await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** retry));
          }
        }
      }
      const retained = { ...profile };
      delete retained.credentials;
      this.store.save(retained);
      return { accountId: id, revocationConfirmed };
    });
  }

  private resolveAccountId(accountId?: string): string {
    const selected = accountId ?? this.store.readHost()?.currentAccountId;
    if (selected === undefined) {
      throw new ChatGptAuthError(
        "login_required",
        "尚未登录 ChatGPT。请运行 roll auth chatgpt login。",
      );
    }
    return z.string().uuid().parse(selected);
  }

  private requireRegistration(id: string): ChatGptRegistration {
    const profile = this.store.read(id);
    if (!profile) {
      throw new ChatGptAuthError(
        "account_not_found",
        "ChatGPT 账号注册不存在，请检查 --account 或重新登录。",
      );
    }
    return profile;
  }

  private requireCredentials(profile: ChatGptRegistration): ChatGptCredential {
    if (!profile.credentials) {
      throw new ChatGptAuthError(
        "login_required",
        "此 ChatGPT 账号需要重新登录：roll auth chatgpt login --account " + profile.id,
      );
    }
    return profile.credentials;
  }

  private canRefresh(credentials: ChatGptCredential): boolean {
    return (
      credentials.earliestRefreshAt === undefined || this.now() >= credentials.earliestRefreshAt
    );
  }

  private async metadata(signal?: AbortSignal): Promise<z.infer<typeof metadataSchema>> {
    signal?.throwIfAborted();
    if (this.metadataValue) return this.metadataValue;
    const response = await readChatGptResponse(
      this.fetch,
      `${this.issuer}/.well-known/openid-configuration`,
      "discovery",
      {
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new ChatGptAuthError(
        "discovery_failed",
        `无法获取 ChatGPT 授权服务配置（HTTP ${response.status}）。请检查 Roll 进程的网络/代理设置后重试。`,
        response.status,
      );
    }
    const metadata = metadataSchema.parse(await response.json());
    if (metadata.issuer !== this.issuer) {
      throw new ChatGptAuthError("invalid_issuer", "ChatGPT 授权服务 issuer 不匹配。");
    }
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.revocation_endpoint,
      metadata.jwks_uri,
    ]) {
      if (
        endpoint !== undefined &&
        (new URL(endpoint).origin !== new URL(this.issuer).origin ||
          new URL(endpoint).protocol !== "https:")
      ) {
        throw new ChatGptAuthError("invalid_endpoint", "ChatGPT 授权服务 endpoint 不可信。");
      }
    }
    this.metadataValue = metadata;
    return metadata;
  }

  private async exchange(
    parameters: Record<string, string>,
    signal?: AbortSignal,
    finishAfterDispatch = false,
  ): Promise<z.infer<typeof tokenResponseSchema>> {
    const metadata = await this.metadata(signal);
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetch(metadata.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters),
        signal:
          signal === undefined || finishAfterDispatch
            ? AbortSignal.timeout(30_000)
            : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new ChatGptAuthError(
        "network_error",
        "ChatGPT 授权网络请求失败，请稍后重试；现有凭证已保留。",
      );
    }
    if (!response.ok) throw await this.responseError(response, "token_exchange_failed");
    try {
      return tokenResponseSchema.parse(await response.json());
    } catch {
      // A 200 refresh can already have consumed the rotating token. Do not retry that old
      // token if its replacement cannot be validated or safely persisted.
      throw new ChatGptAuthError(
        "invalid_token_response",
        "ChatGPT 返回了无法校验的授权凭证，请重新登录。",
        response.status,
      );
    }
  }

  private async identityKeys(signal?: AbortSignal) {
    const metadata = await this.metadata(signal);
    const response = await readChatGptResponse(this.fetch, metadata.jwks_uri, "jwks", {
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new ChatGptAuthError(
        "jwks_unavailable",
        `无法获取 ChatGPT 身份签名密钥（HTTP ${response.status}），请稍后重试；现有凭证已保留。`,
        response.status,
      );
    }
    return createLocalJWKSet(jwksSchema.parse(await response.json()));
  }

  private async validateIdentity(
    token: string,
    clientId: string,
    nonce?: string,
    subject?: string,
    verificationKeys?: Awaited<ReturnType<ChatGptAuthService["identityKeys"]>>,
  ) {
    try {
      const { payload } = await jwtVerify(token, verificationKeys ?? (await this.identityKeys()), {
        issuer: this.issuer,
        audience: clientId,
        algorithms: ["RS256"],
        currentDate: new Date(this.now()),
        requiredClaims: ["exp", "sub", ...(nonce === undefined ? [] : ["nonce"])],
      });
      if (
        !payload.sub ||
        (nonce !== undefined && payload.nonce !== nonce) ||
        (subject !== undefined && payload.sub !== subject)
      ) {
        throw new Error("Identity mismatch");
      }
      const email = z.string().email().safeParse(payload.email);
      return {
        subject: payload.sub,
        ...(email.success ? { email: email.data } : {}),
      };
    } catch {
      throw new ChatGptAuthError(
        "invalid_id_token",
        "ChatGPT 身份签名、issuer、audience、有效期、nonce 或账号校验失败，请重新登录。",
      );
    }
  }

  private credentials(
    token: z.infer<typeof tokenResponseSchema>,
    previous?: ChatGptCredential,
  ): ChatGptCredential {
    const idToken = token.id_token ?? previous?.idToken;
    if (idToken === undefined) {
      throw new ChatGptAuthError("missing_id_token", "ChatGPT 登录响应缺少 ID token。");
    }
    const earliestRefreshAt =
      token.earliest_refresh_at === undefined
        ? undefined
        : typeof token.earliest_refresh_at === "number"
          ? token.earliest_refresh_at * 1000
          : Date.parse(token.earliest_refresh_at);
    if (
      earliestRefreshAt !== undefined &&
      (!Number.isFinite(earliestRefreshAt) ||
        earliestRefreshAt > this.now() + 365 * 24 * 60 * 60_000)
    ) {
      throw new ChatGptAuthError(
        "invalid_refresh_time",
        "ChatGPT earliest_refresh_at 时间格式无法确认，请重新登录或检查服务端响应。",
      );
    }
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken,
      scopes:
        token.scope === undefined
          ? (previous?.scopes ?? [])
          : token.scope.split(/\s+/).filter(Boolean),
      expiresAt: this.now() + token.expires_in * 1000,
      savedAt: this.now(),
      ...(earliestRefreshAt === undefined ? {} : { earliestRefreshAt }),
    };
  }

  private async completeLogin(
    attempt: LoginAttempt,
    input: {
      accountId: string;
      clientId: string;
      hostId: string;
      nonce: string;
      code: string;
      verifier: string;
      redirectUri: string;
    },
  ): Promise<void> {
    try {
      await this.store.withLock(input.accountId, async () => {
        if (attempt.abort.signal.aborted) return;
        const previous = this.store.read(input.accountId);
        const registration = previous ?? {
          id: input.accountId,
          clientId: input.clientId,
          hostId: input.hostId,
        };
        // Keep the newly issued registration even if this single-use code fails later.
        if (previous === undefined) this.store.save(registration);
        const token = await this.exchange(
          {
            grant_type: "authorization_code",
            client_id: input.clientId,
            code: input.code,
            code_verifier: input.verifier,
            redirect_uri: input.redirectUri,
            resource: RESOURCE,
          },
          attempt.abort.signal,
        );
        if (!token.id_token) {
          throw new ChatGptAuthError("missing_id_token", "ChatGPT 登录响应缺少 ID token。");
        }
        const identity = await this.validateIdentity(
          token.id_token,
          input.clientId,
          input.nonce,
          previous?.subject,
        );
        if (attempt.abort.signal.aborted) return;
        await this.store.activate(
          { ...registration, ...identity, credentials: this.credentials(token) },
          () =>
            this.finishAttempt(
              attempt.progress.id,
              "succeeded",
              token.scope?.split(/\s+/).includes(DIRECT_SCOPE)
                ? "ChatGPT 订阅已连接。"
                : "已登录；ChatGPT 订阅用量尚未授权。",
              input.accountId,
            ),
          () => attempt.abort.signal.aborted,
        );
      });
    } catch (error) {
      if (!attempt.abort.signal.aborted) {
        this.finishAttempt(
          attempt.progress.id,
          "failed",
          error instanceof ChatGptAuthError ? error.message : "ChatGPT 登录失败，请重试。",
        );
      }
    }
  }

  private finishAttempt(
    id: string,
    state: ChatGptLoginProgress["state"],
    message: string,
    accountId?: string,
  ): void {
    const attempt = this.attempts.get(id);
    if (attempt === undefined) return;
    attempt.progress = { id, state, message, ...(accountId === undefined ? {} : { accountId }) };
    clearTimeout(attempt.timer);
    attempt.abort.abort();
    attempt.server.close();
    if (state === "cancelled" || state === "timed-out") attempt.server.closeAllConnections();
  }

  private pruneAttempts(): void {
    for (const [id, attempt] of this.attempts) {
      if (this.attempts.size <= 20) return;
      if (attempt.progress.state !== "waiting" && attempt.progress.state !== "exchanging") {
        this.attempts.delete(id);
      }
    }
  }

  private async responseError(response: Response, fallback: string): Promise<ChatGptAuthError> {
    let code = fallback;
    try {
      const data: unknown = await response.json();
      const parsed = z
        .object({
          error: z.union([z.string(), z.object({ code: z.string().optional() })]).optional(),
        })
        .safeParse(data);
      const candidate = parsed.success
        ? typeof parsed.data.error === "string"
          ? parsed.data.error
          : parsed.data.error?.code
        : undefined;
      if (errorCodeSchema.safeParse(candidate).success && candidate !== undefined) code = candidate;
    } catch {
      /* Keep a safe stable diagnostic; never echo an arbitrary credential-bearing body. */
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    return new ChatGptAuthError(
      code,
      `ChatGPT 请求失败（HTTP ${response.status}, ${code}）。`,
      response.status,
      requestId,
    );
  }
}

function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error) => {
      if (error) reject(new ChatGptAuthError("browser_failed", "无法打开系统浏览器。"));
      else resolve();
    });
  });
}

export function createChatGptAuthService(
  options: ChatGptAuthServiceOptions = {},
): ChatGptAuthService {
  return new ChatGptAuthService(options);
}
let sharedService: ChatGptAuthService | undefined;
export function getChatGptAuthService(): ChatGptAuthService {
  sharedService ??= createChatGptAuthService();
  return sharedService;
}
