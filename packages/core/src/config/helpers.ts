import type { AgentSkillEnvDeclarations } from "../types/agent.ts";
import type { AskRuntimeIssue } from "../types/ask.ts";
import type { RollConfig } from "./schema.ts";

const ENV_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/;

type AgentEnvMap = RollConfig["agents"]["env"];
type LlmProviderConfig = RollConfig["llm"]["providers"][string];

export const LLM_CONFIG_STATUS_CODES = [
  "ready",
  "missing-provider",
  "missing-api-key",
  "unresolved-api-key",
] as const;
export type LlmConfigStatusCode = (typeof LLM_CONFIG_STATUS_CODES)[number];

export interface LlmConfigReadiness {
  readonly configured: boolean;
  readonly status: LlmConfigStatusCode;
  readonly provider: string;
  readonly model: string;
  readonly summary: string;
  readonly message: string;
  readonly providerConfig?: LlmProviderConfig;
}

export interface AgentEnvCheckItem {
  readonly name: string;
  readonly required: boolean;
  readonly purpose?: string;
  readonly example?: string;
  readonly default?: string;
  readonly source: "agents.env" | "process.env" | "default" | "missing";
}

export interface AgentEnvCheckReport {
  readonly items: readonly AgentEnvCheckItem[];
  readonly missingRequired: readonly AgentEnvCheckItem[];
  readonly processEnvOnlyRequired: readonly AgentEnvCheckItem[];
}

export function hasUnresolvedEnvPlaceholder(value: string): boolean {
  return ENV_PLACEHOLDER_PATTERN.test(value);
}

export function inspectLlmConfigReadiness(
  config: RollConfig,
  options: { readonly provider?: string; readonly model?: string } = {},
): LlmConfigReadiness {
  const provider = options.provider ?? config.llm.defaultProvider;
  const model = options.model ?? config.llm.defaultModel;
  const providerConfig = config.llm.providers[provider];
  const summary = `${provider}/${model}`;

  if (!providerConfig) {
    return {
      configured: false,
      status: "missing-provider",
      provider,
      model,
      summary,
      message: `LLM provider "${provider}" 未配置。请运行 roll setup 或 roll config setup llm`,
    };
  }

  const apiKey = providerConfig.apiKey.trim();
  if (apiKey.length === 0) {
    return {
      configured: false,
      status: "missing-api-key",
      provider,
      model,
      summary,
      message: `LLM provider "${provider}" 的 apiKey 未配置。请运行 roll setup 或 roll config setup llm`,
      providerConfig,
    };
  }

  if (hasUnresolvedEnvPlaceholder(apiKey)) {
    return {
      configured: false,
      status: "unresolved-api-key",
      provider,
      model,
      summary,
      message: `LLM provider "${provider}" 的 apiKey 仍是未解析的环境变量占位符。请设置对应环境变量，或运行 roll setup / roll config setup llm`,
      providerConfig,
    };
  }

  return {
    configured: true,
    status: "ready",
    provider,
    model,
    summary,
    message: `LLM provider "${provider}" 已配置`,
    providerConfig,
  };
}

function getAgentEnvFromMap(
  envMap: AgentEnvMap,
  agentName: string,
): Readonly<Record<string, string>> | undefined {
  return envMap?.[agentName];
}

export function getAgentEnvFromAgentsConfig(
  agentsConfig: RollConfig["agents"],
  agentName: string,
): Readonly<Record<string, string>> | undefined {
  return filterResolvedAgentEnv(getAgentEnvFromMap(agentsConfig.env, agentName));
}

/** 获取指定 Agent 的环境变量配置，没有则返回 undefined */
export function getAgentEnv(
  config: RollConfig,
  agentName: string,
): Readonly<Record<string, string>> | undefined {
  const configuredEnv = getAgentEnvFromAgentsConfig(config.agents, agentName);
  if (agentName !== "browser-use-agent" || Object.keys(config.browser.instances).length === 0) {
    return configuredEnv;
  }

  return {
    ...(configuredEnv ?? {}),
    BROWSER_INSTANCES_JSON: JSON.stringify(config.browser),
  };
}

export function inspectAgentEnvRequirements(
  agentName: string,
  declarations: AgentSkillEnvDeclarations | undefined,
  envMap: AgentEnvMap,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): AgentEnvCheckReport | undefined {
  if (!declarations) {
    return undefined;
  }

  const configuredEnv = filterResolvedAgentEnv(getAgentEnvFromMap(envMap, agentName));
  const items = [
    ...buildAgentEnvCheckItems(declarations.required, true, configuredEnv, inheritedEnv),
    ...buildAgentEnvCheckItems(declarations.optional, false, configuredEnv, inheritedEnv),
  ];

  if (items.length === 0) {
    return undefined;
  }

  return {
    items,
    missingRequired: items.filter((item) => item.required && item.source === "missing"),
    processEnvOnlyRequired: items.filter((item) => item.required && item.source === "process.env"),
  };
}

export function getMissingAgentEnvRuntimeIssues(
  report: AgentEnvCheckReport | undefined,
): ReadonlyArray<AskRuntimeIssue> {
  if (!report) {
    return [];
  }

  return report.missingRequired.map((item) => ({
    category: "env",
    code: "missing_required_env",
    name: item.name,
    message: `必填环境变量 ${item.name} 未配置`,
    ...(item.purpose ? { purpose: item.purpose } : {}),
    ...(item.example ? { example: item.example } : {}),
  }));
}

function buildAgentEnvCheckItems(
  declarations: AgentSkillEnvDeclarations["required"] | AgentSkillEnvDeclarations["optional"],
  required: boolean,
  configuredEnv: Readonly<Record<string, string>> | undefined,
  inheritedEnv: NodeJS.ProcessEnv,
): AgentEnvCheckItem[] {
  if (!declarations) {
    return [];
  }

  return declarations.map((declaration) => {
    const configuredValue = configuredEnv?.[declaration.name];
    if (configuredValue !== undefined && configuredValue.length > 0) {
      return { ...declaration, required, source: "agents.env" };
    }

    const inheritedValue = inheritedEnv[declaration.name];
    if (typeof inheritedValue === "string" && inheritedValue.length > 0) {
      return { ...declaration, required, source: "process.env" };
    }

    if (declaration.default) {
      return { ...declaration, required, source: "default" };
    }

    return { ...declaration, required, source: "missing" };
  });
}

function filterResolvedAgentEnv(
  env: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!env) {
    return undefined;
  }

  const filteredEntries = Object.entries(env).filter(([, value]) => isResolvedEnvValue(value));
  if (filteredEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(filteredEntries);
}

function isResolvedEnvValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !ENV_PLACEHOLDER_PATTERN.test(value);
}
