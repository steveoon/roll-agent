import { z } from "zod";

export const providerConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().optional(),
});

export const llmConfigSchema = z.object({
  defaultProvider: z.string(),
  defaultModel: z.string(),
  providers: z.record(z.string(), providerConfigSchema),
});

export const askConfigSchema = z.object({
  llmModel: z.string().optional(),
  confirmThreshold: z.number().optional(),
});

export const agentsConfigSchema = z.object({
  dataDir: z.string(),
  /** per-agent 环境变量：键为 agent name，值为 key-value 对 */
  env: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

export const rollConfigSchema = z.object({
  llm: llmConfigSchema,
  ask: askConfigSchema,
  agents: agentsConfigSchema,
});

export type RollConfig = z.infer<typeof rollConfigSchema>;
