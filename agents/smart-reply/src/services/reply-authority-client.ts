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

function buildHeaders(config: ReplyAuthorityConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
  };
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

async function postJson(
  config: ReplyAuthorityConfig,
  pathname: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(buildEndpoint(config.baseUrl, pathname), {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal,
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(parseErrorMessage(response.status, payload));
  }

  return payload;
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
  signal: AbortSignal,
): Promise<ResolveRecruiterBindingResponse> {
  const request = buildResolveRecruiterBindingRequest(target);
  const payload = await postJson(config, "resolve-recruiter-binding", request, signal);
  return ResolveRecruiterBindingResponseSchema.parse(payload);
}

function resolveTargetOrThrow(
  resolved: ResolveRecruiterBindingResponse,
  target: ReplyAuthorityTarget,
): { tenantId: string; recruiterBinding: RecruiterBinding } {
  if (target.tenantId !== undefined && target.tenantId !== resolved.tenantId) {
    throw new Error(
      `Reply Authority Service recruiter 解析结果与 target.tenantId 不一致：${resolved.tenantId}`,
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
  signal: AbortSignal,
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
    });
  }

  const resolved = await resolveRecruiterBinding(config, input.target, signal);
  const resolvedTarget = resolveTargetOrThrow(resolved, input.target);

  return GenerateSignedReplyRequestSchema.parse({
    ...input,
    target: {
      platform: input.target.platform,
      tenantId: resolvedTarget.tenantId,
      conversationId: input.target.conversationId,
      candidateId: input.target.candidateId,
      recruiterBinding: resolvedTarget.recruiterBinding,
    },
  });
}

export async function generateSignedReply(
  input: GenerateReplyToolInput,
): Promise<GenerateSignedReplyResponse> {
  const parsedToolInput = GenerateReplyToolInputSchema.parse(input);
  const parsedInput = GenerateSignedReplyRequestSchema.safeParse(parsedToolInput);
  const config = loadReplyAuthorityConfig();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const request = parsedInput.success
      ? parsedInput.data
      : await buildGenerateSignedReplyRequest(parsedToolInput, config, controller.signal);
    const payload = await postJson(config, "generate-signed-reply", request, controller.signal);
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
