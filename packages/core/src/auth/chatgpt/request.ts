import { setTimeout as delay } from "node:timers/promises";
import { ChatGptAuthError } from "./errors.ts";

const readPhases = { discovery: "授权服务配置", jwks: "身份签名密钥", models: "模型列表" } as const;
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function networkCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string" && networkCodes.has(error.code)) {
    return error.code;
  }
  if (error instanceof Error && error.cause !== error) {
    const cause = error.cause;
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string" &&
      networkCodes.has(cause.code)
    ) {
      return cause.code;
    }
  }
  return undefined;
}

/** Retry only idempotent reads. Never use this helper for rotating token exchanges. */
export async function readChatGptResponse(
  send: typeof fetch,
  url: string,
  phase: keyof typeof readPhases,
  options: {
    signal?: AbortSignal;
    headers?: NonNullable<Parameters<typeof fetch>[1]>["headers"];
    retryDelaysMs?: readonly number[];
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 12_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const delays = options.retryDelaysMs ?? [200, 600];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      signal.throwIfAborted();
      const response = await send(url, {
        method: "GET",
        signal,
        redirect: "error",
        ...(options.headers ? { headers: options.headers } : {}),
      });
      if (
        !(response.status === 408 || response.status === 429 || response.status >= 500) ||
        attempt === delays.length
      ) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw options.signal.reason;
      if (signal.aborted || attempt === delays.length) break;
    }
    try {
      await delay(delays[attempt] ?? 0, undefined, { signal });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = error;
      break;
    }
  }
  const detail = networkCode(lastError) ?? (signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
  throw new ChatGptAuthError(
    phase === "jwks" ? "jwks_unavailable" : "network_error",
    `无法获取 ChatGPT ${readPhases[phase]}（${detail}），自动重试未恢复；现有凭证已保留。请检查网络后重试。`,
    undefined,
    undefined,
    { cause: lastError },
  );
}
