import { z } from "zod";
import type { FunnelStage } from "./reply-policy.ts";
import { ChannelTypeSchema } from "./reply-policy.ts";
import type { ReplyContext } from "./zhipin.ts";

// ========== Provider / Model Config Schemas ==========

export const ProviderConfigSchema = z.object({
  name: z.string(),
  baseURL: z.string(),
  description: z.string(),
});

export const ProviderConfigsSchema = z.record(z.string(), ProviderConfigSchema);

export const ModelConfigSchema = z.object({
  chatModel: z.string().optional(),
  classifyModel: z.string().optional(),
  replyModel: z.string().optional(),
  providerConfigs: ProviderConfigsSchema.optional(),
});

// ========== Classification Agent Schema ==========

export const BrandDataSchema = z.object({
  city: z.string().optional(),
  defaultBrand: z.string(),
  availableBrands: z.array(z.string()),
  storeCount: z.number(),
});

export const ClassificationOptionsSchema = z.object({
  modelConfig: ModelConfigSchema,
  candidateMessage: z.string(),
  conversationHistory: z.array(z.string()).default([]),
  brandData: BrandDataSchema.optional(),
  channelType: ChannelTypeSchema.optional(),
});

// ========== Stage → ReplyType mapping ==========

const STAGE_TO_REPLY_TYPE: Record<FunnelStage, ReplyContext> = {
  trust_building: "general_chat",
  private_channel: "followup_chat",
  qualify_candidate: "attendance_inquiry",
  job_consultation: "salary_inquiry",
  interview_scheduling: "interview_request",
  onboard_followup: "followup_chat",
};

export function stageToLegacyReplyType(stage?: FunnelStage): ReplyContext {
  if (!stage) return "general_chat";
  return STAGE_TO_REPLY_TYPE[stage];
}

// ========== Type exports ==========
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ProviderConfigs = z.infer<typeof ProviderConfigsSchema>;
export type BrandData = z.infer<typeof BrandDataSchema>;
export type ClassificationOptions = z.infer<typeof ClassificationOptionsSchema>;
