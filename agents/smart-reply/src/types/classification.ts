import { z } from "zod";
import { ChannelTypeSchema } from "./reply-policy.ts";

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

// ========== Type exports ==========
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ProviderConfigs = z.infer<typeof ProviderConfigsSchema>;
export type BrandData = z.infer<typeof BrandDataSchema>;
export type ClassificationOptions = z.infer<typeof ClassificationOptionsSchema>;
