import {
  GenerateSignedReplyRequestSchema,
  GenerateSignedReplyResponseSchema,
  ReplyAuthorityErrorResponseSchema,
  type GenerateSignedReplyRequest,
  type GenerateSignedReplyResponse,
} from "../types/reply-authority.ts";

const REQUEST_TIMEOUT_MS = 20_000;

interface ReplyAuthorityConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
}

function getRequiredEnv(name: "REPLY_AUTHORITY_URL" | "REPLY_AUTHORITY_BEARER_TOKEN"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置，smart-reply-agent 无法调用 Reply Authority Service。`);
  }
  return value;
}

function loadReplyAuthorityConfig(): ReplyAuthorityConfig {
  return {
    baseUrl: getRequiredEnv("REPLY_AUTHORITY_URL"),
    bearerToken: getRequiredEnv("REPLY_AUTHORITY_BEARER_TOKEN"),
  };
}

function buildEndpoint(baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(pathname, normalizedBaseUrl).toString();
}

function parseErrorMessage(status: number, payload: unknown): string {
  const parsed = ReplyAuthorityErrorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return `Reply Authority Service 请求失败 (${status}): ${parsed.data.message}`;
  }

  return `Reply Authority Service 请求失败 (${status})`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Reply Authority Service 返回了非 JSON 响应。");
  }
}

export async function generateSignedReply(
  input: GenerateSignedReplyRequest,
): Promise<GenerateSignedReplyResponse> {
  const request = GenerateSignedReplyRequestSchema.parse(input);
  const config = loadReplyAuthorityConfig();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildEndpoint(config.baseUrl, "generate-signed-reply"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.bearerToken}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(parseErrorMessage(response.status, payload));
    }

    return GenerateSignedReplyResponseSchema.parse(payload);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Reply Authority Service 请求超时。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
