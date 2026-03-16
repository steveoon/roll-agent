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
  /** per-agent 环境变量：键为 agent name，值为 key-value 对 */
  env: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

export const rollConfigSchema = z.object({
  llm: llmConfigSchema,
  router: routerConfigSchema,
  agents: agentsConfigSchema,
});

export type RollConfig = z.infer<typeof rollConfigSchema>;

/** 获取指定 Agent 的环境变量配置，没有则返回 undefined */
export function getAgentEnv(
  config: RollConfig,
  agentName: string,
): Readonly<Record<string, string>> | undefined {
  return config.agents.env?.[agentName];
}
