import type { RollConfig } from "./schema.ts";

/** 默认配置值 */
export const DEFAULT_CONFIG: RollConfig = {
  llm: {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    providers: {},
  },
  ask: {},
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
