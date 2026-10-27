import { APICallError } from "@ai-sdk/provider";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";

/** A verified premature EOF, not a malformed completion or a failed server response. */
export class ChatGptStreamInterruptedError extends Error {
  constructor() {
    super(
      "ChatGPT Responses stream ended without response.completed (before successful completion).",
    );
    this.name = "ChatGptStreamInterruptedError";
  }
}

/** Preserve structured server codes without making business/protocol errors retryable. */
export class ChatGptResponseError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string) {
    super(`${code === undefined ? "" : `${code}: `}${message}`);
    this.name = "ChatGptResponseError";
    this.code = code;
  }
}

function hasBusinessErrorCode(value: unknown): boolean {
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 8 && typeof value === "object" && value !== null && !seen.has(value);
    depth += 1
  ) {
    seen.add(value);
    if ("code" in value && typeof value.code === "string") return true;
    value = "error" in value ? value.error : "response" in value ? value.response : undefined;
  }
  return false;
}

export function isRecoverableChatGptError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && error !== undefined && !seen.has(error); depth += 1) {
    seen.add(error);
    if (error instanceof ChatGptStreamInterruptedError) return true;
    if (error instanceof ChatGptAuthError) {
      return error.code === "network_error" || error.code === "jwks_unavailable";
    }
    if (APICallError.isInstance(error) && hasBusinessErrorCode(error.data)) return false;
    if (
      APICallError.isInstance(error) &&
      error.statusCode !== undefined &&
      (error.statusCode < 200 || error.statusCode >= 300)
    ) {
      // Only explicit transient transport/service statuses, not 429 (possibly quota).
      return [408, 502, 503, 504].includes(error.statusCode);
    }
    // SDK body-reading errors retain the successful HTTP status. Only typed
    // transport evidence in their cause makes them recoverable, not the 2xx itself.
    error = error instanceof Error ? error.cause : undefined;
  }
  return false;
}

/** Runs at the HTTP body boundary, so transport exceptions cannot be confused with parser errors. */
export function guardChatGptResponseBody(
  response: Response,
  signal: AbortSignal | null | undefined,
  onNetworkError: ((error: ChatGptAuthError) => void) | undefined,
): Response {
  if (!response.ok || response.body === null) return response;
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            reader.releaseLock();
          } else controller.enqueue(value);
        } catch (cause) {
          const error = signal?.aborted
            ? signal.reason
            : new ChatGptAuthError(
                "network_error",
                "ChatGPT 网络连接中断，未完成的回复需要重新生成。",
                undefined,
                undefined,
                { cause },
              );
          try {
            if (error instanceof ChatGptAuthError) onNetworkError?.(error);
          } catch {
            // The optional status observer must not replace the sanitized transport error.
          }
          controller.error(error);
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
