import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { z } from "zod";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export const FunnelStageValues = [
  "trust_building",
  "private_channel",
  "qualify_candidate",
  "job_consultation",
  "interview_scheduling",
  "onboard_followup",
] as const;

export const FunnelStageSchema = z.enum(FunnelStageValues);

export const ProviderConfigSchema = z.object({
  name: z.string(),
  baseURL: z.string(),
  description: z.string(),
});

export const ProviderConfigsSchema = z.record(z.string(), ProviderConfigSchema);

export const ReasoningConfigSchema = z.object({
  enabled: z.boolean(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  scope: z.enum(["reply", "all"]).optional(),
});

export const ModelConfigSchema = z.object({
  chatModel: z.string().optional(),
  classifyModel: z.string().optional(),
  replyModel: z.string().optional(),
  reasoning: ReasoningConfigSchema.optional(),
  providerConfigs: ProviderConfigsSchema.optional(),
});

export const CandidateInfoSchema = z.object({
  name: z.string().optional(),
  position: z.string().optional(),
  expectedPosition: z.string().optional(),
  communicationPosition: z.string().optional(),
  age: z.string().optional(),
  gender: z.string().optional(),
  experience: z.string().optional(),
  education: z.string().optional(),
  expectedSalary: z.string().optional(),
  expectedLocation: z.string().optional(),
  jobAddress: z.string().optional(),
  height: z.string().optional(),
  weight: z.string().optional(),
  healthCertificate: z.boolean().optional(),
  activeTime: z.string().optional(),
  info: z.array(z.string()).optional(),
  fullText: z.string().optional(),
});

export const CandidateLocationSignalSourceValues = [
  "candidate_message",
  "conversation_history",
  "candidate_expected_location",
  "communication_position",
] as const;

export const CandidateLocationSignalIntentValues = [
  "nearby_store",
  "store_address",
  "expected_area",
] as const;

export const CandidateLocationSignalSchema = z.object({
  text: z.string().min(1),
  source: z.enum(CandidateLocationSignalSourceValues),
  city: z.string().min(1).optional(),
  intent: z.enum(CandidateLocationSignalIntentValues).optional(),
  confidence: z.number().min(0).max(1),
});

export const RecruiterBindingSchema = z.object({
  platform: z.literal("zhipin"),
  username: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

const ReplyAuthorityTargetBaseSchema = z.object({
  platform: z.literal("zhipin"),
  tenantId: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  candidateId: z.string().min(1),
});

export const ReplyAuthorityTargetSchema = ReplyAuthorityTargetBaseSchema.extend({
  recruiterBinding: RecruiterBindingSchema.optional(),
  recruiterUsername: z.string().min(1).optional(),
}).superRefine((target, ctx) => {
  const hasRecruiterBinding = target.recruiterBinding !== undefined;
  const hasRecruiterUsername = target.recruiterUsername !== undefined;

  if (!hasRecruiterBinding && !hasRecruiterUsername) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "target.recruiterBinding 或 target.recruiterUsername 至少需要提供一个。",
      path: ["recruiterBinding"],
    });
  }

  if (hasRecruiterBinding && !hasRecruiterUsername && target.tenantId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "直接传 target.recruiterBinding 时，target.tenantId 也必须显式提供。",
      path: ["tenantId"],
    });
  }

  if (
    hasRecruiterBinding &&
    hasRecruiterUsername &&
    target.recruiterBinding !== undefined &&
    target.recruiterBinding.username !== target.recruiterUsername
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "target.recruiterUsername 必须与 target.recruiterBinding.username 一致。",
      path: ["recruiterUsername"],
    });
  }
});

export const ResolvedReplyAuthorityTargetSchema = ReplyAuthorityTargetBaseSchema.extend({
  tenantId: z.string().min(1),
  recruiterBinding: RecruiterBindingSchema,
});

export const GenerateReplyToolInputSchema = z.object({
  candidateMessage: z.string().describe("候选人发送的消息"),
  conversationHistory: z.array(z.string()).optional().describe("对话历史（最近几轮）"),
  candidateInfo: CandidateInfoSchema.optional().describe("候选人基本信息"),
  locationSignals: z
    .array(CandidateLocationSignalSchema)
    .optional()
    .describe(
      "已废弃：候选人地点查询证据。服务端合并规划上线后由服务端自行提取并校验，新调用方不应传入",
    ),
  preferredBrand: z.string().optional().describe("偏好品牌"),
  preferredBrandId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("沟通职位尾缀 [品牌ID] 解析出的 Duliday 品牌 ID"),
  channelType: z
    .enum(["public", "private"])
    .optional()
    .describe("渠道类型: public(BOSS直聘) 或 private(微信)"),
  defaultWechatId: z.string().optional().describe("默认微信号"),
  industryVoiceId: z.string().optional().describe("行业语调ID"),
  turnIndex: z.number().int().min(1).optional().describe("当前会话回复轮次"),
  modelConfig: ModelConfigSchema.optional().describe("模型配置覆盖"),
  target: ReplyAuthorityTargetSchema.describe("签名绑定目标：租户、会话和候选人标识"),
});

export const GenerateSignedReplyRequestSchema = GenerateReplyToolInputSchema.omit({
  target: true,
}).extend({
  target: ResolvedReplyAuthorityTargetSchema,
  requestId: z.string().optional(),
});

export const GenerateSignedReplyStreamRequestSchema = GenerateSignedReplyRequestSchema.extend({
  stream: z.literal(true),
});

export const PrepareReplyContextInputSchema = GenerateReplyToolInputSchema.omit({
  defaultWechatId: true,
  locationSignals: true,
});

export const PrepareReplyContextRequestSchema = PrepareReplyContextInputSchema.omit({
  target: true,
}).extend({
  target: ResolvedReplyAuthorityTargetSchema,
  requestId: z.string().optional(),
});

export const PrepareReplyContextStatusValues = ["created", "reused", "throttled"] as const;

export const PrepareReplyContextResponseSchema = z.object({
  prepared: z.boolean(),
  hasPreviousState: z.boolean().optional(),
  conversationKey: z.string().min(1),
  expiresAt: z.number().int().min(0),
  status: z.enum(PrepareReplyContextStatusValues),
});

export const ReplyGateAdvisoryCodeValues = [
  "too_many_questions",
  "audit_tone",
  "reply_overpacked",
  "off_axis_fact_disclosure",
] as const;

export const ReplyVariantKindValues = ["draft", "revised"] as const;

export const ReplyFeedbackOutcomeValues = ["selected", "not_learned"] as const;

export const ReplyFeedbackDecisionSourceValues = [
  "judge",
  "orchestrator",
  "service_recommended_fallback",
  "explicit_no_judge",
] as const;

export const ReplyFeedbackStatusValues = ["accepted", "duplicate"] as const;

export const ReplyGateAdvisoryCodeSchema = z.enum(ReplyGateAdvisoryCodeValues);

export const ReplyVariantKindSchema = z.enum(ReplyVariantKindValues);

export const ReplyVariantItemSchema = z.object({
  variant: ReplyVariantKindSchema,
  suggestedReply: z.string(),
  signedEnvelope: z.string().min(1),
  envelopeExp: z.number().int().min(0),
});

export const ReplyVariantFindingSchema = z.object({
  code: ReplyGateAdvisoryCodeSchema,
  description: z.string().min(1),
});

export const ReplyVariantsSchema = z.object({
  groupId: z.string().min(1),
  recommended: z.literal("draft"),
  items: z.array(ReplyVariantItemSchema).min(2).max(2),
  findings: z.array(ReplyVariantFindingSchema).min(1),
  rubricVersion: z.string().min(1),
  rubricHash: z
    .string()
    .min(1)
    .regex(/^sha256:/),
  feedbackExpiresAt: z.number().int().min(0).optional(),
});

const ReplyFeedbackTargetSchema = z.object({
  platform: z.literal("zhipin"),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
});

export const ReplyFeedbackBodySchema = z
  .object({
    groupId: z.string().min(1),
    target: ReplyFeedbackTargetSchema,
    chosenVariant: ReplyVariantKindSchema,
    feedbackOutcome: z.enum(ReplyFeedbackOutcomeValues).optional(),
    decisionSource: z.enum(ReplyFeedbackDecisionSourceValues).optional(),
    confirmedFindingCodes: z.array(ReplyGateAdvisoryCodeSchema).optional(),
    reason: z.string().min(1).max(500),
    rubricVersion: z.string().min(1),
    rubricHash: z
      .string()
      .min(1)
      .regex(/^sha256:/),
    judgeModel: z.string().min(1).optional(),
  })
  .superRefine((body, ctx) => {
    const feedbackOutcome = body.feedbackOutcome ?? "selected";
    if (
      feedbackOutcome === "selected" &&
      (body.decisionSource === "service_recommended_fallback" ||
        body.decisionSource === "explicit_no_judge")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selected feedback requires judge or orchestrator source",
        path: ["decisionSource"],
      });
    }
    if (feedbackOutcome !== "not_learned") {
      return;
    }
    if (
      body.decisionSource !== "service_recommended_fallback" &&
      body.decisionSource !== "explicit_no_judge"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "not_learned feedback requires service_recommended_fallback or explicit_no_judge source",
        path: ["decisionSource"],
      });
    }
    if (body.confirmedFindingCodes !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "not_learned feedback must not include confirmedFindingCodes",
        path: ["confirmedFindingCodes"],
      });
    }
  });

export const ReplyFeedbackResponseSchema = z.object({
  status: z.enum(ReplyFeedbackStatusValues),
  groupId: z.string().min(1),
});

export const ReplyFeedbackRubricResponseSchema = z.object({
  rubricVersion: z.string().min(1),
  rubricHash: z
    .string()
    .min(1)
    .regex(/^sha256:/),
  rubric: z.record(z.unknown()),
  advisoryFindings: z.array(ReplyVariantFindingSchema),
});

export const GenerateSignedReplyResponseSchema = z.object({
  suggestedReply: z.string(),
  signedEnvelope: z.string().describe("Reply Authority Service v2 紧凑签名信封"),
  envelopeExp: z.number().int(),
  confidence: z.number(),
  stage: FunnelStageSchema,
  replyPolicySource: z.enum(["file", "default"]),
  latencyMs: z.number().optional(),
  shouldExchangeWechat: z.boolean().optional(),
  error: z.string().optional(),
  diagnostics: z.record(z.unknown()).optional(),
  replyVariants: ReplyVariantsSchema.optional(),
});

export const ResolveRecruiterBindingRequestSchema = z.object({
  platform: z.literal("zhipin"),
  username: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

export const ResolveRecruiterBindingResponseSchema = z.object({
  tenantId: z.string().min(1),
  recruiterBinding: RecruiterBindingSchema,
});

export const ReplyAuthorityErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
});

export const ReplyStreamEventSchema = z
  .object({
    type: z.string(),
    sequence: z.number().int().min(1),
    timestamp: z.string(),
  })
  .passthrough();

export const ReplyStreamErrorEventSchema = ReplyStreamEventSchema.extend({
  type: z.literal("error"),
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
});

export const ReplyStreamFinalEventSchema = ReplyStreamEventSchema.extend({
  type: z.literal("final"),
  safeToSend: z.literal(true),
  suggestedReply: z.string(),
  signedEnvelope: z.string().min(1),
  envelopeExp: z.number().int(),
  confidence: z.number(),
  stage: FunnelStageSchema,
  replyPolicySource: z.enum(["file", "default"]),
  latencyMs: z.number().optional(),
  shouldExchangeWechat: z.boolean().optional(),
  error: z.string().optional(),
  diagnostics: z.record(z.unknown()).optional(),
  replyVariants: ReplyVariantsSchema.optional(),
});

export const LocationResolvedInquiryTypeValues = [
  "location_inquiry",
  "non_location_inquiry",
] as const;

export const LocationResolvedAnalysisPathValues = ["llm", "speculative", "none"] as const;

export const ReplyStreamLocationResolvedEventSchema = ReplyStreamEventSchema.extend({
  type: z.literal("location.resolved"),
  inquiryType: z.enum(LocationResolvedInquiryTypeValues),
  signals: z.array(CandidateLocationSignalSchema).default([]),
  analysisPath: z.enum(LocationResolvedAnalysisPathValues),
});

export interface ReplyAuthorityConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}

interface ResolvedReplyAuthorityConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
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
  readonly statusCode?: number;
}

export class ReplyAuthorityRequestError extends Error {
  readonly meta: ReplyAuthorityRequestMeta;
  readonly statusCode: number | undefined;

  constructor(message: string, options: ReplyAuthorityRequestErrorOptions) {
    super(`${message} (${formatRequestMeta(options.meta)})`, { cause: options.cause });
    this.name = "ReplyAuthorityRequestError";
    this.meta = options.meta;
    this.statusCode = options.statusCode;
  }
}

export type FunnelStage = z.infer<typeof FunnelStageSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderConfigs = z.infer<typeof ProviderConfigsSchema>;
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type CandidateInfo = z.infer<typeof CandidateInfoSchema>;
export type CandidateLocationSignal = z.infer<typeof CandidateLocationSignalSchema>;
export type RecruiterBinding = z.infer<typeof RecruiterBindingSchema>;
export type ReplyAuthorityTarget = z.infer<typeof ReplyAuthorityTargetSchema>;
export type ResolvedReplyAuthorityTarget = z.infer<typeof ResolvedReplyAuthorityTargetSchema>;
export type GenerateReplyToolInput = z.infer<typeof GenerateReplyToolInputSchema>;
export type GenerateSignedReplyRequest = z.infer<typeof GenerateSignedReplyRequestSchema>;
export type GenerateSignedReplyResponse = z.infer<typeof GenerateSignedReplyResponseSchema>;
export type GenerateSignedReplyStreamRequest = z.infer<
  typeof GenerateSignedReplyStreamRequestSchema
>;
export type PrepareReplyContextInput = z.infer<typeof PrepareReplyContextInputSchema>;
export type PrepareReplyContextRequest = z.infer<typeof PrepareReplyContextRequestSchema>;
export type PrepareReplyContextStatus = (typeof PrepareReplyContextStatusValues)[number];
export type PrepareReplyContextResponse = z.infer<typeof PrepareReplyContextResponseSchema>;
export type ReplyGateAdvisoryCode = z.infer<typeof ReplyGateAdvisoryCodeSchema>;
export type ReplyVariantKind = z.infer<typeof ReplyVariantKindSchema>;
export type ReplyFeedbackOutcome = (typeof ReplyFeedbackOutcomeValues)[number];
export type ReplyFeedbackDecisionSource = (typeof ReplyFeedbackDecisionSourceValues)[number];
export type ReplyVariantItem = z.infer<typeof ReplyVariantItemSchema>;
export type ReplyVariantFinding = z.infer<typeof ReplyVariantFindingSchema>;
export type ReplyVariants = z.infer<typeof ReplyVariantsSchema>;
export type ReplyFeedbackBody = z.infer<typeof ReplyFeedbackBodySchema>;
export type ReplyFeedbackResponse = z.infer<typeof ReplyFeedbackResponseSchema>;
export type ReplyFeedbackRubricResponse = z.infer<typeof ReplyFeedbackRubricResponseSchema>;
export type ResolveRecruiterBindingRequest = z.infer<typeof ResolveRecruiterBindingRequestSchema>;
export type ResolveRecruiterBindingResponse = z.infer<typeof ResolveRecruiterBindingResponseSchema>;
export type ReplyStreamEvent = z.infer<typeof ReplyStreamEventSchema>;
export type ReplyStreamFinalEvent = z.infer<typeof ReplyStreamFinalEventSchema>;
export type ReplyStreamLocationResolvedEvent = z.infer<
  typeof ReplyStreamLocationResolvedEventSchema
>;
export type LocationResolvedInquiryType = (typeof LocationResolvedInquiryTypeValues)[number];
export type LocationResolvedAnalysisPath = (typeof LocationResolvedAnalysisPathValues)[number];

function resolveRequestTimeoutMs(configuredTimeoutMs: number | undefined): number {
  if (configuredTimeoutMs !== undefined) {
    return Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const raw = process.env.REPLY_AUTHORITY_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return parsed;
}

function getRequiredEnv(name: "REPLY_AUTHORITY_URL" | "REPLY_AUTHORITY_BEARER_TOKEN"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置，无法调用 Reply Authority Service。`);
  }
  return value;
}

function loadReplyAuthorityConfig(config?: ReplyAuthorityConfig): ResolvedReplyAuthorityConfig {
  return {
    baseUrl: config?.baseUrl ?? getRequiredEnv("REPLY_AUTHORITY_URL"),
    bearerToken: config?.bearerToken ?? getRequiredEnv("REPLY_AUTHORITY_BEARER_TOKEN"),
    timeoutMs: resolveRequestTimeoutMs(config?.timeoutMs),
  };
}

function buildEndpoint(baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(pathname, normalizedBaseUrl).toString();
}

function buildHeaders(
  config: ResolvedReplyAuthorityConfig,
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
  config: ResolvedReplyAuthorityConfig,
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
  config: ResolvedReplyAuthorityConfig,
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
      const failure = new Error(parseErrorMessage(response.status, payload));
      throw new ReplyAuthorityRequestError(failure.message, {
        meta,
        statusCode: response.status,
        cause: failure,
      });
    }

    return payload;
  } catch (error) {
    throw wrapReplyAuthorityRequestError(error, meta);
  }
}

async function getJson(
  config: ResolvedReplyAuthorityConfig,
  pathname: string,
  requestContext: ReplyAuthorityRequestContext,
): Promise<unknown> {
  const meta = buildRequestMeta(config, pathname, requestContext);

  try {
    const response = await fetch(meta.url, {
      method: "GET",
      headers: buildHeaders(config, requestContext),
      signal: requestContext.signal,
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      const failure = new Error(parseErrorMessage(response.status, payload));
      throw new ReplyAuthorityRequestError(failure.message, {
        meta,
        statusCode: response.status,
        cause: failure,
      });
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
  config: ResolvedReplyAuthorityConfig,
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

async function resolveReplyAuthorityTarget(
  config: ResolvedReplyAuthorityConfig,
  target: ReplyAuthorityTarget,
  requestContext: ReplyAuthorityRequestContext,
): Promise<ResolvedReplyAuthorityTarget> {
  if (target.recruiterBinding !== undefined && target.tenantId !== undefined) {
    return ResolvedReplyAuthorityTargetSchema.parse({
      platform: target.platform,
      tenantId: target.tenantId,
      conversationId: target.conversationId,
      candidateId: target.candidateId,
      recruiterBinding: target.recruiterBinding,
    });
  }

  const resolved = await resolveRecruiterBinding(config, target, requestContext);
  const resolvedTarget = resolveTargetOrThrow(
    resolved,
    target,
    buildRequestMeta(config, "resolve-recruiter-binding", requestContext),
  );

  return ResolvedReplyAuthorityTargetSchema.parse({
    platform: target.platform,
    tenantId: resolvedTarget.tenantId,
    conversationId: target.conversationId,
    candidateId: target.candidateId,
    recruiterBinding: resolvedTarget.recruiterBinding,
  });
}

async function buildGenerateSignedReplyRequest(
  input: GenerateReplyToolInput,
  config: ResolvedReplyAuthorityConfig,
  requestContext: ReplyAuthorityRequestContext,
): Promise<GenerateSignedReplyRequest> {
  return GenerateSignedReplyRequestSchema.parse({
    ...input,
    target: await resolveReplyAuthorityTarget(config, input.target, requestContext),
    requestId: requestContext.requestId,
  });
}

async function buildPrepareReplyContextRequest(
  input: PrepareReplyContextInput,
  config: ResolvedReplyAuthorityConfig,
  requestContext: ReplyAuthorityRequestContext,
): Promise<PrepareReplyContextRequest> {
  return PrepareReplyContextRequestSchema.parse({
    ...input,
    target: await resolveReplyAuthorityTarget(config, input.target, requestContext),
    requestId: requestContext.requestId,
  });
}

function createRequestContext(timeoutMs: number): {
  readonly context: ReplyAuthorityRequestContext;
  readonly clear: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    context: {
      signal: controller.signal,
      timeoutMs,
      requestId: randomUUID(),
    },
    clear: () => clearTimeout(timeoutId),
  };
}

async function prepareGenerateSignedReplyRequest(
  input: GenerateReplyToolInput,
  config: ResolvedReplyAuthorityConfig,
  requestContext: ReplyAuthorityRequestContext,
): Promise<GenerateSignedReplyRequest> {
  const parsedToolInput = GenerateReplyToolInputSchema.parse(input);
  const parsedInput = GenerateSignedReplyRequestSchema.safeParse(parsedToolInput);

  return parsedInput.success
    ? GenerateSignedReplyRequestSchema.parse({
        ...parsedInput.data,
        requestId: parsedInput.data.requestId ?? requestContext.requestId,
      })
    : await buildGenerateSignedReplyRequest(parsedToolInput, config, requestContext);
}

async function preparePrepareReplyContextRequest(
  input: PrepareReplyContextInput,
  config: ResolvedReplyAuthorityConfig,
  requestContext: ReplyAuthorityRequestContext,
): Promise<PrepareReplyContextRequest> {
  const parsedToolInput = PrepareReplyContextInputSchema.parse(input);
  const parsedInput = PrepareReplyContextRequestSchema.safeParse(parsedToolInput);

  return parsedInput.success
    ? PrepareReplyContextRequestSchema.parse({
        ...parsedInput.data,
        requestId: parsedInput.data.requestId ?? requestContext.requestId,
      })
    : await buildPrepareReplyContextRequest(parsedToolInput, config, requestContext);
}

export async function generateSignedReply(
  input: GenerateReplyToolInput,
  configInput?: ReplyAuthorityConfig,
): Promise<GenerateSignedReplyResponse> {
  const config = loadReplyAuthorityConfig(configInput);
  const { context: requestContext, clear } = createRequestContext(config.timeoutMs);

  try {
    const request = await prepareGenerateSignedReplyRequest(input, config, requestContext);
    const payload = await postJson(config, "generate-signed-reply", request, requestContext);
    return parseReplyAuthorityPayload(
      GenerateSignedReplyResponseSchema,
      payload,
      buildRequestMeta(config, "generate-signed-reply", requestContext),
      "Reply Authority Service 签名回复",
    );
  } finally {
    clear();
  }
}

export async function prepareReplyContext(
  input: PrepareReplyContextInput,
  configInput?: ReplyAuthorityConfig,
): Promise<PrepareReplyContextResponse> {
  const config = loadReplyAuthorityConfig(configInput);
  const { context: requestContext, clear } = createRequestContext(config.timeoutMs);

  try {
    const request = await preparePrepareReplyContextRequest(input, config, requestContext);
    const payload = await postJson(config, "prepare-reply-context", request, requestContext);
    return parseReplyAuthorityPayload(
      PrepareReplyContextResponseSchema,
      payload,
      buildRequestMeta(config, "prepare-reply-context", requestContext),
      "Reply Authority Service 回复上下文预热",
    );
  } finally {
    clear();
  }
}

export async function fetchReplyFeedbackRubric(
  input: {
    readonly tenantId: string;
    readonly rubricVersion: string;
  },
  configInput?: ReplyAuthorityConfig,
): Promise<ReplyFeedbackRubricResponse> {
  const config = loadReplyAuthorityConfig(configInput);
  const { context: requestContext, clear } = createRequestContext(config.timeoutMs);
  const tenantId = encodeURIComponent(input.tenantId);
  const rubricVersion = encodeURIComponent(input.rubricVersion);
  const pathname = `tenants/${tenantId}/reply-feedback/rubrics/${rubricVersion}`;

  try {
    const payload = await getJson(config, pathname, requestContext);
    return parseReplyAuthorityPayload(
      ReplyFeedbackRubricResponseSchema,
      payload,
      buildRequestMeta(config, pathname, requestContext),
      "Reply Authority Service judge rubric",
    );
  } finally {
    clear();
  }
}

export async function postReplyFeedback(
  body: ReplyFeedbackBody,
  configInput?: ReplyAuthorityConfig,
): Promise<ReplyFeedbackResponse> {
  const config = loadReplyAuthorityConfig(configInput);
  const { context: requestContext, clear } = createRequestContext(config.timeoutMs);

  try {
    const request = ReplyFeedbackBodySchema.parse(body);
    const payload = await postJson(config, "reply-feedback", request, requestContext);
    return parseReplyAuthorityPayload(
      ReplyFeedbackResponseSchema,
      payload,
      buildRequestMeta(config, "reply-feedback", requestContext),
      "Reply Authority Service reply feedback",
    );
  } finally {
    clear();
  }
}

export function parseSseFrame(frame: string): ReplyStreamEvent | undefined {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));

  if (dataLines.length === 0) {
    return undefined;
  }

  const parsedPayload: unknown = JSON.parse(dataLines.join("\n"));
  return ReplyStreamEventSchema.parse(parsedPayload);
}

function parseFinalSignedReplyEvent(event: ReplyStreamEvent): ReplyStreamFinalEvent {
  const parsed = ReplyStreamFinalEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new Error("Reply Authority Service final event 响应校验失败。");
  }
  return parsed.data;
}

function throwSseErrorEvent(event: ReplyStreamEvent, meta: ReplyAuthorityRequestMeta): never {
  const parsed = ReplyStreamErrorEventSchema.safeParse(event);
  if (parsed.success) {
    throw new ReplyAuthorityRequestError(
      `Reply Authority Service stream 失败 (${String(parsed.data.statusCode)}): ${parsed.data.message}`,
      { meta, statusCode: parsed.data.statusCode },
    );
  }

  throw new ReplyAuthorityRequestError("Reply Authority Service stream 失败。", { meta });
}

async function openSseResponse(
  config: ResolvedReplyAuthorityConfig,
  request: GenerateSignedReplyStreamRequest,
  requestContext: ReplyAuthorityRequestContext,
): Promise<Response> {
  const meta = buildRequestMeta(config, "generate-signed-reply", requestContext);

  try {
    const response = await fetch(meta.url, {
      method: "POST",
      headers: buildHeaders(config, requestContext),
      body: JSON.stringify(request),
      signal: requestContext.signal,
    });
    const contentType = (response.headers.get("content-type") ?? "").toLocaleLowerCase("en-US");

    if (!response.ok || !contentType.includes("text/event-stream")) {
      const payload = await parseJsonResponse(response).catch(() => undefined);
      if (!response.ok) {
        const failure = new Error(parseErrorMessage(response.status, payload));
        throw new ReplyAuthorityRequestError(failure.message, {
          meta,
          statusCode: response.status,
          cause: failure,
        });
      }
      throw new Error("Reply Authority Service 返回了非 SSE 响应。");
    }

    if (!response.body) {
      throw new Error("Reply Authority Service stream 响应体不可用。");
    }

    return response;
  } catch (error) {
    throw wrapReplyAuthorityRequestError(error, meta);
  }
}

function normalizeSseBuffer(buffer: string): string {
  return buffer.replace(/\r\n/g, "\n");
}

export async function* streamGenerateSignedReply(
  input: GenerateReplyToolInput,
  configInput?: ReplyAuthorityConfig,
): AsyncGenerator<ReplyStreamEvent> {
  const config = loadReplyAuthorityConfig(configInput);
  const { context: requestContext, clear } = createRequestContext(config.timeoutMs);
  const meta = buildRequestMeta(config, "generate-signed-reply", requestContext);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const request = GenerateSignedReplyStreamRequestSchema.parse({
      ...(await prepareGenerateSignedReplyRequest(input, config, requestContext)),
      stream: true,
    });
    const response = await openSseResponse(config, request, requestContext);
    reader = response.body?.getReader();
    if (!reader) {
      throw new ReplyAuthorityRequestError("Reply Authority Service stream 响应体不可用。", {
        meta,
      });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let lastSequence = 0;
    let sawFinal = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer = normalizeSseBuffer(buffer + decoder.decode(value, { stream: true }));
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (event === undefined) {
          continue;
        }
        if (event.sequence !== lastSequence + 1) {
          throw new ReplyAuthorityRequestError(
            `Reply Authority Service stream sequence 不连续：expected ${String(
              lastSequence + 1,
            )}, received ${String(event.sequence)}`,
            { meta },
          );
        }
        lastSequence = event.sequence;
        if (event.type === "error") {
          throwSseErrorEvent(event, meta);
        }
        if (event.type === "final") {
          parseFinalSignedReplyEvent(event);
          sawFinal = true;
        }
        yield event;
      }
    }

    buffer = normalizeSseBuffer(buffer + decoder.decode());
    const trailingEvent = buffer.trim().length > 0 ? parseSseFrame(buffer) : undefined;
    if (trailingEvent !== undefined) {
      if (trailingEvent.sequence !== lastSequence + 1) {
        throw new ReplyAuthorityRequestError(
          `Reply Authority Service stream sequence 不连续：expected ${String(
            lastSequence + 1,
          )}, received ${String(trailingEvent.sequence)}`,
          { meta },
        );
      }
      if (trailingEvent.type === "error") {
        throwSseErrorEvent(trailingEvent, meta);
      }
      if (trailingEvent.type === "final") {
        parseFinalSignedReplyEvent(trailingEvent);
        sawFinal = true;
      }
      yield trailingEvent;
    }

    if (!sawFinal) {
      throw new ReplyAuthorityRequestError(
        "Reply Authority Service stream 在 final 前结束，禁止发送草稿。",
        { meta },
      );
    }
  } catch (error) {
    throw wrapReplyAuthorityRequestError(error, meta);
  } finally {
    await reader?.cancel().catch(() => {});
    clear();
  }
}

export async function collectFinalSignedReply(
  events: AsyncIterable<ReplyStreamEvent>,
): Promise<GenerateSignedReplyResponse> {
  let finalEvent: ReplyStreamFinalEvent | undefined;

  for await (const event of events) {
    if (event.type === "final") {
      finalEvent = parseFinalSignedReplyEvent(event);
    }
  }

  if (finalEvent === undefined) {
    throw new Error("Reply Authority Service stream 未返回 final。");
  }

  return GenerateSignedReplyResponseSchema.parse(finalEvent);
}
