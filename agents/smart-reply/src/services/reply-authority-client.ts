import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import {
  GenerateReplyToolInputSchema,
  ResolveRecruiterBindingRequestSchema,
  ResolveRecruiterBindingResponseSchema,
  GenerateSignedReplyRequestSchema,
  GenerateSignedReplyResponseSchema,
  ReplyAuthorityErrorResponseSchema,
  type GenerateReplyToolInput,
  type GenerateSignedReplyRequest,
  type GenerateSignedReplyResponse,
  type RecruiterBinding,
  type ReplyAuthorityTarget,
  type ResolveRecruiterBindingRequest,
  type ResolveRecruiterBindingResponse,
} from "../types/reply-authority.ts";

const REQUEST_TIMEOUT_MS = 20_000;

interface ReplyAuthorityConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
}

interface ReplyAuthorityRequestMeta {
  readonly url: string;
  readonly timeoutMs: number;
  readonly requestId?: string;
}

interface ReplyAuthorityRequestContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly requestId: string;
}

interface ReplyAuthorityRequestErrorOptions extends ErrorOptions {
  readonly meta: ReplyAuthorityRequestMeta;
}

export class ReplyAuthorityRequestError extends Error {
  readonly meta: ReplyAuthorityRequestMeta;

  constructor(message: string, options: ReplyAuthorityRequestErrorOptions) {
    super(`${message} (${formatRequestMeta(options.meta)})`, { cause: options.cause });
    this.name = "ReplyAuthorityRequestError";
    this.meta = options.meta;
  }
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

function buildHeaders(
  config: ReplyAuthorityConfig,
  requestContext: ReplyAuthorityRequestContext,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
    "x-request-id": requestContext.requestId,
  };
}

function parseErrorMessage(status: number, payload: unknown): string {
  const parsed = ReplyAuthorityErrorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return `Reply Authority Service 请求失败 (${status}): ${parsed.data.message}`;
  }

  return `Reply Authority Service 请求失败 (${status})`;
}

function formatRequestMeta(meta: ReplyAuthorityRequestMeta): string {
  const details = [`url=${meta.url}`, `timeoutMs=${String(meta.timeoutMs)}`];
  if (meta.requestId !== undefined) {
    details.push(`requestId=${meta.requestId}`);
  }
  return details.join(", ");
}

function buildRequestMeta(
  config: ReplyAuthorityConfig,
  pathname: string,
  requestContext: ReplyAuthorityRequestContext,
): ReplyAuthorityRequestMeta {
  return {
    url: buildEndpoint(config.baseUrl, pathname),
    timeoutMs: requestContext.timeoutMs,
    requestId: requestContext.requestId,
  };
}

function wrapReplyAuthorityRequestError(
  error: unknown,
  meta: ReplyAuthorityRequestMeta,
): ReplyAuthorityRequestError {
  if (error instanceof ReplyAuthorityRequestError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new ReplyAuthorityRequestError("Reply Authority Service 请求超时。", {
      cause: error,
      meta,
    });
  }

  if (error instanceof Error) {
    return new ReplyAuthorityRequestError(error.message, {
      cause: error,
      meta,
    });
  }

  return new ReplyAuthorityRequestError("Reply Authority Service 请求失败。", {
    cause: error,
    meta,
  });
}

function parseReplyAuthorityPayload<T>(
  schema: ZodType<T>,
  payload: unknown,
  meta: ReplyAuthorityRequestMeta,
  responseLabel: string,
): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  throw new ReplyAuthorityRequestError(`${responseLabel} 响应校验失败。`, {
    cause: parsed.error,
    meta,
  });
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

async function postJson(
  config: ReplyAuthorityConfig,
  pathname: string,
  body: unknown,
  requestContext: ReplyAuthorityRequestContext,
): Promise<unknown> {
  const meta = buildRequestMeta(config, pathname, requestContext);

  try {
    const response = await fetch(meta.url, {
      method: "POST",
      headers: buildHeaders(config, requestContext),
      body: JSON.stringify(body),
      signal: requestContext.signal,
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(parseErrorMessage(response.status, payload));
    }

    return payload;
  } catch (error) {
    throw wrapReplyAuthorityRequestError(error, meta);
  }
}

function buildResolveRecruiterBindingRequest(
  target: ReplyAuthorityTarget,
): ResolveRecruiterBindingRequest {
  return ResolveRecruiterBindingRequestSchema.parse({
    platform: target.platform,
    username: target.recruiterUsername,
  });
}

async function resolveRecruiterBinding(
  config: ReplyAuthorityConfig,
  target: ReplyAuthorityTarget,
  requestContext: ReplyAuthorityRequestContext,
): Promise<ResolveRecruiterBindingResponse> {
  const request = buildResolveRecruiterBindingRequest(target);
  const payload = await postJson(config, "resolve-recruiter-binding", request, requestContext);
  return parseReplyAuthorityPayload(
    ResolveRecruiterBindingResponseSchema,
    payload,
    buildRequestMeta(config, "resolve-recruiter-binding", requestContext),
    "Reply Authority Service recruiter 解析",
  );
}

function resolveTargetOrThrow(
  resolved: ResolveRecruiterBindingResponse,
  target: ReplyAuthorityTarget,
  meta: ReplyAuthorityRequestMeta,
): { tenantId: string; recruiterBinding: RecruiterBinding } {
  if (target.tenantId !== undefined && target.tenantId !== resolved.tenantId) {
    throw new ReplyAuthorityRequestError(
      `Reply Authority Service recruiter 解析结果与 target.tenantId 不一致：${resolved.tenantId}`,
      { meta },
    );
  }

  return {
    tenantId: resolved.tenantId,
    recruiterBinding: resolved.recruiterBinding,
  };
}

async function buildGenerateSignedReplyRequest(
  input: GenerateReplyToolInput,
  config: ReplyAuthorityConfig,
  requestContext: ReplyAuthorityRequestContext,
): Promise<GenerateSignedReplyRequest> {
  if (input.target.recruiterBinding !== undefined && input.target.tenantId !== undefined) {
    return GenerateSignedReplyRequestSchema.parse({
      ...input,
      target: {
        platform: input.target.platform,
        tenantId: input.target.tenantId,
        conversationId: input.target.conversationId,
        candidateId: input.target.candidateId,
        recruiterBinding: input.target.recruiterBinding,
      },
      requestId: requestContext.requestId,
    });
  }

  const resolved = await resolveRecruiterBinding(config, input.target, requestContext);
  const resolvedTarget = resolveTargetOrThrow(
    resolved,
    input.target,
    buildRequestMeta(config, "resolve-recruiter-binding", requestContext),
  );

  return GenerateSignedReplyRequestSchema.parse({
    ...input,
    target: {
      platform: input.target.platform,
      tenantId: resolvedTarget.tenantId,
      conversationId: input.target.conversationId,
      candidateId: input.target.candidateId,
      recruiterBinding: resolvedTarget.recruiterBinding,
    },
    requestId: requestContext.requestId,
  });
}

export async function generateSignedReply(
  input: GenerateReplyToolInput,
): Promise<GenerateSignedReplyResponse> {
  const parsedToolInput = GenerateReplyToolInputSchema.parse(input);
  const parsedInput = GenerateSignedReplyRequestSchema.safeParse(parsedToolInput);
  const config = loadReplyAuthorityConfig();
  const controller = new AbortController();
  const requestContext = {
    signal: controller.signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    requestId: randomUUID(),
  } as const;
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const request = parsedInput.success
      ? GenerateSignedReplyRequestSchema.parse({
          ...parsedInput.data,
          requestId: parsedInput.data.requestId ?? requestContext.requestId,
        })
      : await buildGenerateSignedReplyRequest(parsedToolInput, config, requestContext);
    const payload = await postJson(config, "generate-signed-reply", request, requestContext);
    return parseReplyAuthorityPayload(
      GenerateSignedReplyResponseSchema,
      payload,
      buildRequestMeta(config, "generate-signed-reply", requestContext),
      "Reply Authority Service 签名回复",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
