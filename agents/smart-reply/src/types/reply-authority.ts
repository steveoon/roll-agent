import { z } from "zod";
import { ModelConfigSchema } from "./model-config.ts";
import { FunnelStageSchema } from "./funnel-stage.ts";
import { CandidateInfoSchema } from "./candidate-info.ts";

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
  preferredBrand: z.string().optional().describe("偏好品牌"),
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

export type RecruiterBinding = z.infer<typeof RecruiterBindingSchema>;
export type ReplyAuthorityTarget = z.infer<typeof ReplyAuthorityTargetSchema>;
export type ResolvedReplyAuthorityTarget = z.infer<typeof ResolvedReplyAuthorityTargetSchema>;
export type GenerateReplyToolInput = z.infer<typeof GenerateReplyToolInputSchema>;
export type GenerateSignedReplyRequest = z.infer<typeof GenerateSignedReplyRequestSchema>;
export type GenerateSignedReplyResponse = z.infer<typeof GenerateSignedReplyResponseSchema>;
export type ResolveRecruiterBindingRequest = z.infer<typeof ResolveRecruiterBindingRequestSchema>;
export type ResolveRecruiterBindingResponse = z.infer<typeof ResolveRecruiterBindingResponseSchema>;
