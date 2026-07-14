import { rollConfigSchema, type RollConfig } from "./schema.ts";

export const LLM_PROVIDER_OPTIONS = ["anthropic", "openai", "qwen", "deepseek"] as const;
export type LlmProviderOption = (typeof LLM_PROVIDER_OPTIONS)[number];

export const DEFAULT_LLM_PROVIDER: LlmProviderOption = "anthropic";

export const DEFAULT_LLM_MODELS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  qwen: "qwen3.6-plus",
  deepseek: "deepseek-v4-flash",
} as const satisfies Record<LlmProviderOption, string>;

/** 仅为 schema 中没有默认值、但根配置要求存在的字段提供种子。 */
const DEFAULT_CONFIG_SEED = {
  llm: {
    defaultProvider: DEFAULT_LLM_PROVIDER,
    defaultModel: DEFAULT_LLM_MODELS[DEFAULT_LLM_PROVIDER],
    providers: {},
  },
  ask: {},
  agents: {
    dataDir: "~/.roll-agent/agents",
  },
} as const;

/** 默认配置值；除上述必填 seed 外，全部由 rollConfigSchema 的默认值生成。 */
export const DEFAULT_CONFIG: RollConfig = rollConfigSchema.parse(DEFAULT_CONFIG_SEED);

/** 配置文件查找顺序 */
export const CONFIG_FILE_NAMES = ["roll.config.yaml", "roll.config.yml"] as const;
