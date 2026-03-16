import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { CandidateInfoSchema } from "../types/zhipin.ts";
import { loadBrandConfig, loadReplyPolicy } from "../services/config-loader.ts";
import { generateSmartReply } from "../pipeline/smart-reply.ts";
import { ChannelTypeSchema } from "../types/reply-policy.ts";
import { ModelConfigSchema } from "../types/classification.ts";

export const generateReply = defineTool({
  name: "generate_reply",
  description:
    "根据候选人消息、对话历史和品牌数据生成智能招聘回复。内部流程：回合规划 → needs 驱动上下文构建 → 年龄资格校验 → 策略化回复生成 → FactGate 校验。",
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
    modelConfig: ModelConfigSchema.optional().describe("模型配置覆盖"),
  }),
  output: z.object({
    suggestedReply: z.string(),
    confidence: z.number(),
    stage: z.string(),
    shouldExchangeWechat: z.boolean().optional(),
    error: z.string().optional(),
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
        stage: "trust_building",
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
      modelConfig: input.modelConfig,
      configData,
      replyPolicy,
    });

    ctx.logger.info(
      `Reply generated. Stage: ${result.turnPlan.stage}, Confidence: ${result.confidence}`,
    );

    return {
      suggestedReply: result.suggestedReply,
      confidence: result.confidence,
      stage: result.turnPlan.stage,
      shouldExchangeWechat: result.shouldExchangeWechat,
      error: result.error?.userMessage,
    };
  },
});
