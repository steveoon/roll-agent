import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { CandidateInfoSchema } from "../types/zhipin.ts";
import { loadBrandConfig, loadReplyPolicy } from "../services/config-loader.ts";
import { generateSmartReply } from "../pipeline/smart-reply.ts";
import { AGE_ELIGIBILITY_STATUSES } from "../pipeline/age-eligibility.ts";
import {
  ChannelTypeSchema,
  EffectiveDisclosureModeSchema,
  FunnelStageSchema,
  ReplyNeedSchema,
  RiskFlagSchema,
} from "../types/reply-policy.ts";
import { REPLY_GATE_VIOLATION_CODES } from "../pipeline/reply-gate.ts";
import { ModelConfigSchema } from "../types/classification.ts";

const ReplyGateViolationCodeSchema = z.enum(REPLY_GATE_VIOLATION_CODES);
const AgeEligibilityStatusSchema = z.enum(AGE_ELIGIBILITY_STATUSES);

export const generateReply = defineTool({
  name: "generate_reply",
  description:
    "根据候选人消息、对话历史和品牌数据生成智能招聘回复。内部流程：回合规划 → primaryNeed 驱动上下文构建 → 年龄资格校验 → 策略化回复生成 → FactGate/ReplyGate 校验。",
  input: z.object({
    candidateMessage: z.string().describe("候选人发送的消息"),
    conversationHistory: z.array(z.string()).optional().describe("对话历史（最近几轮）"),
    candidateInfo: CandidateInfoSchema.optional().describe("候选人基本信息"),
    preferredBrand: z.string().optional().describe("偏好品牌"),
    channelType: ChannelTypeSchema.optional().describe(
      "渠道类型: public(BOSS直聘) 或 private(微信)",
    ),
    defaultWechatId: z.string().optional().describe("默认微信号"),
    industryVoiceId: z.string().optional().describe("行业语调ID"),
    turnIndex: z.number().int().min(1).optional().describe("当前会话回复轮次"),
    modelConfig: ModelConfigSchema.optional().describe("模型配置覆盖"),
  }),
  output: z.object({
    suggestedReply: z.string(),
    confidence: z.number(),
    stage: FunnelStageSchema,
    latencyMs: z.number().optional(),
    shouldExchangeWechat: z.boolean().optional(),
    error: z.string().optional(),
    diagnostics: z
      .object({
        subGoals: z.array(z.string()),
        needs: z.array(ReplyNeedSchema),
        primaryNeed: ReplyNeedSchema,
        riskFlags: z.array(RiskFlagSchema),
        reasoningText: z.string(),
        extractedInfo: z.object({
          mentionedBrand: z.string().nullable(),
          city: z.string().nullable(),
          specificAge: z.number().nullable(),
          hasUrgency: z.boolean().nullable(),
          preferredSchedule: z.string().nullable(),
        }),
        ageGate: z.object({
          enabled: z.boolean(),
          status: AgeEligibilityStatusSchema,
          strategy: z.string(),
        }),
        resolvedBrand: z.string(),
        storeCount: z.number(),
        detailLevel: EffectiveDisclosureModeSchema,
        turnIndex: z.number(),
        effectiveDisclosureMode: EffectiveDisclosureModeSchema,
        replyGateRewritten: z.boolean(),
        gateViolations: z.array(ReplyGateViolationCodeSchema),
        factGateRewritten: z.boolean(),
      })
      .optional(),
  }),
  execute: async (input, ctx) => {
    ctx.logger.info(`Processing message: ${input.candidateMessage.slice(0, 50)}...`);

    let configData;
    try {
      configData = loadBrandConfig();
    } catch {
      return {
        suggestedReply: "",
        confidence: 0,
        stage: "trust_building" as const,
        error: "品牌数据未配置，请先调用 sync_brand_data 写入数据",
      };
    }

    const replyPolicy = loadReplyPolicy();

    const result = await generateSmartReply({
      candidateMessage: input.candidateMessage,
      conversationHistory: input.conversationHistory,
      candidateInfo: input.candidateInfo,
      preferredBrand: input.preferredBrand,
      channelType: input.channelType,
      defaultWechatId: input.defaultWechatId,
      industryVoiceId: input.industryVoiceId,
      turnIndex: input.turnIndex,
      modelConfig: input.modelConfig,
      configData,
      replyPolicy,
    });

    ctx.logger.info(
      `Reply generated. Stage: ${result.turnPlan.stage}, Confidence: ${result.confidence}`,
    );

    const debug = result.debugInfo;
    return {
      suggestedReply: result.suggestedReply,
      confidence: result.confidence,
      stage: result.turnPlan.stage,
      latencyMs: result.latencyMs,
      shouldExchangeWechat: result.shouldExchangeWechat,
      error: result.error?.userMessage,
      diagnostics: debug
        ? {
            subGoals: result.turnPlan.subGoals,
            needs: result.turnPlan.needs,
            primaryNeed: result.turnPlan.primaryNeed,
            riskFlags: result.turnPlan.riskFlags,
            reasoningText: result.turnPlan.reasoningText,
            extractedInfo: {
              mentionedBrand: result.turnPlan.extractedInfo.mentionedBrand ?? null,
              city: result.turnPlan.extractedInfo.city ?? null,
              specificAge: result.turnPlan.extractedInfo.specificAge ?? null,
              hasUrgency: result.turnPlan.extractedInfo.hasUrgency ?? null,
              preferredSchedule: result.turnPlan.extractedInfo.preferredSchedule ?? null,
            },
            ageGate: {
              enabled: debug.appliedStrategy.enabled,
              status: debug.gateStatus,
              strategy: debug.appliedStrategy.strategy,
            },
            resolvedBrand: debug.resolvedBrand,
            storeCount: debug.storeCount,
            detailLevel: debug.detailLevel,
            turnIndex: debug.turnIndex,
            effectiveDisclosureMode: debug.effectiveDisclosureMode,
            replyGateRewritten: result.replyGateRewritten,
            gateViolations: result.gateViolations,
            factGateRewritten: result.factGateRewritten,
          }
        : undefined,
    };
  },
});
