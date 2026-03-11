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

export const routerConfigSchema = z.object({
  mode: z.enum(["declarative", "llm", "auto"]),
  llmModel: z.string().optional(),
  confirmThreshold: z.number().optional(),
});

export const agentsConfigSchema = z.object({
  dataDir: z.string(),
});

export const rollConfigSchema = z.object({
  llm: llmConfigSchema,
  router: routerConfigSchema,
  agents: agentsConfigSchema,
});

export type RollConfig = z.infer<typeof rollConfigSchema>;
