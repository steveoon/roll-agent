import type { RollConfig } from "./schema.ts";

export const LLM_PROVIDER_OPTIONS = ["anthropic", "openai", "qwen", "deepseek"] as const;
export type LlmProviderOption = (typeof LLM_PROVIDER_OPTIONS)[number];

export const DEFAULT_LLM_PROVIDER: LlmProviderOption = "anthropic";

export const DEFAULT_LLM_MODELS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  qwen: "qwen3.6-plus",
  deepseek: "deepseek-v4-flash",
} as const satisfies Record<LlmProviderOption, string>;

/** 默认配置值 */
export const DEFAULT_CONFIG: RollConfig = {
  llm: {
    defaultProvider: DEFAULT_LLM_PROVIDER,
    defaultModel: DEFAULT_LLM_MODELS[DEFAULT_LLM_PROVIDER],
    providers: {},
  },
  ask: {},
  runtime: {
    maxSteps: 80,
    turnTimeoutMs: 300_000,
    threadsDir: "~/.roll-agent/threads",
    thinkingLevel: "medium",
    approval: {
      default: "guarded",
      overrides: {},
    },
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 4,
      keepRecentTokens: 32_000,
    },
  },
  agents: {
    dataDir: "~/.roll-agent/agents",
  },
  install: {
    fetchRetries: 3,
    preferOffline: false,
    networkTimeoutMs: 120_000,
  },
  browser: {
    instances: {},
  },
};

/** 配置文件查找顺序 */
export const CONFIG_FILE_NAMES = ["roll.config.yaml", "roll.config.yml"] as const;
