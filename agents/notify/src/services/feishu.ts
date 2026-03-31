import { z } from "zod";

export const FEISHU_WEBHOOK_ERROR_TYPES = [
  "network",
  "timeout",
  "http",
  "invalid-response",
  "provider",
] as const;

export const FeishuWebhookErrorTypeSchema = z.enum(FEISHU_WEBHOOK_ERROR_TYPES);

const FeishuWebhookApiResponseSchema = z
  .object({
    code: z.number(),
    msg: z.string().optional(),
    StatusMessage: z.string().optional(),
  })
  .passthrough();

const FeishuSendSuccessSchema = z.object({
  success: z.literal(true),
  responseCode: z.number(),
  responseMessage: z.string(),
});

const FeishuSendFailureSchema = z.object({
  success: z.literal(false),
  errorType: FeishuWebhookErrorTypeSchema,
  error: z.string(),
  responseCode: z.number().optional(),
  responseMessage: z.string().optional(),
});

export const FeishuSendResultSchema = z.discriminatedUnion("success", [
  FeishuSendSuccessSchema,
  FeishuSendFailureSchema,
]);

export type FeishuWebhookErrorType = z.infer<typeof FeishuWebhookErrorTypeSchema>;
export type FeishuSendResult = z.infer<typeof FeishuSendResultSchema>;

export interface SendFeishuWebhookOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface FeishuResponseMeta {
  readonly responseCode?: number;
  readonly responseMessage?: string;
  readonly rawBody?: string;
}

type FeishuWebhookApiResponse = z.infer<typeof FeishuWebhookApiResponseSchema>;

type ParsedResponseBody =
  | {
      readonly ok: true;
      readonly response: FeishuWebhookApiResponse;
      readonly meta: FeishuResponseMeta;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly meta: FeishuResponseMeta;
    };

const DEFAULT_FEISHU_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_SNIPPET_LENGTH = 200;

export async function sendFeishuWebhook(
  webhookUrl: string,
  text: string,
  options: SendFeishuWebhookOptions = {},
): Promise<FeishuSendResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FEISHU_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text } }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return createFailure("timeout", `Feishu webhook request timed out after ${timeoutMs}ms`);
      }

      return createFailure("network", `Feishu webhook request failed: ${getErrorMessage(error)}`);
    }

    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      return createFailure("http", formatHttpError(response, responseBody.meta), responseBody.meta);
    }

    if (!responseBody.ok) {
      return createFailure("invalid-response", responseBody.error, responseBody.meta);
    }

    const message = getFeishuResponseMessage(responseBody.response) ?? "success";
    if (responseBody.response.code === 0) {
      return {
        success: true,
        responseCode: responseBody.response.code,
        responseMessage: message,
      };
    }

    return createFailure(
      "provider",
      `Feishu API error (${responseBody.response.code}): ${message}`,
      {
        responseCode: responseBody.response.code,
        responseMessage: message,
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function createFailure(
  errorType: FeishuWebhookErrorType,
  error: string,
  meta: FeishuResponseMeta = {},
): FeishuSendResult {
  return {
    success: false as const,
    errorType,
    error,
    ...pickResponseMeta(meta),
  };
}

function pickResponseMeta(meta: FeishuResponseMeta): {
  readonly responseCode?: number;
  readonly responseMessage?: string;
} {
  return {
    ...(meta.responseCode !== undefined ? { responseCode: meta.responseCode } : {}),
    ...(meta.responseMessage ? { responseMessage: meta.responseMessage } : {}),
  };
}

async function readResponseBody(response: Response): Promise<ParsedResponseBody> {
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read Feishu response body: ${getErrorMessage(error)}`,
      meta: {},
    };
  }

  if (rawBody.trim().length === 0) {
    return {
      ok: false,
      error: "Feishu webhook returned an empty response body",
      meta: {},
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      error: `Feishu webhook returned non-JSON response: ${truncate(rawBody)}`,
      meta: { rawBody: truncate(rawBody) },
    };
  }

  const parsed = FeishuWebhookApiResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Feishu webhook returned JSON with an unexpected shape",
      meta: { rawBody: truncate(rawBody) },
    };
  }

  const responseMessage = getFeishuResponseMessage(parsed.data);
  return {
    ok: true,
    response: parsed.data,
    meta: {
      responseCode: parsed.data.code,
      ...(responseMessage ? { responseMessage } : {}),
    },
  };
}

function getFeishuResponseMessage(response: FeishuWebhookApiResponse): string | undefined {
  return response.msg ?? response.StatusMessage;
}

function formatHttpError(response: Response, meta: FeishuResponseMeta): string {
  const statusText = response.statusText || "Request failed";
  if (meta.responseMessage) {
    return `HTTP ${response.status}: ${statusText}; Feishu message: ${meta.responseMessage}`;
  }

  if (meta.rawBody) {
    return `HTTP ${response.status}: ${statusText}; response body: ${meta.rawBody}`;
  }

  return `HTTP ${response.status}: ${statusText}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string): string {
  return value.length > MAX_RESPONSE_SNIPPET_LENGTH
    ? `${value.slice(0, MAX_RESPONSE_SNIPPET_LENGTH)}...`
    : value;
}
