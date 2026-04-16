import { z } from "zod";

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

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderConfigs = z.infer<typeof ProviderConfigsSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
