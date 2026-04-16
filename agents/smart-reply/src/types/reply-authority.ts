import { z } from "zod";
import { ModelConfigSchema } from "./model-config.ts";
import { FunnelStageSchema } from "./funnel-stage.ts";
import { CandidateInfoSchema } from "./candidate-info.ts";

export const ReplyAuthorityTargetSchema = z.object({
  platform: z.literal("zhipin"),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  candidateId: z.string().min(1),
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

export const GenerateSignedReplyRequestSchema = GenerateReplyToolInputSchema.extend({
  requestId: z.string().optional(),
});

export const GenerateSignedReplyResponseSchema = z.object({
  suggestedReply: z.string(),
  signedEnvelope: z.string(),
  envelopeExp: z.number().int(),
  confidence: z.number(),
  stage: FunnelStageSchema,
  replyPolicySource: z.enum(["file", "default"]),
  latencyMs: z.number().optional(),
  shouldExchangeWechat: z.boolean().optional(),
  error: z.string().optional(),
  diagnostics: z.record(z.unknown()).optional(),
});

export const ReplyAuthorityErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
});

export type ReplyAuthorityTarget = z.infer<typeof ReplyAuthorityTargetSchema>;
export type GenerateReplyToolInput = z.infer<typeof GenerateReplyToolInputSchema>;
export type GenerateSignedReplyRequest = z.infer<typeof GenerateSignedReplyRequestSchema>;
export type GenerateSignedReplyResponse = z.infer<typeof GenerateSignedReplyResponseSchema>;
