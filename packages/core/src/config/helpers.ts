import type { AgentSkillEnvDeclarations } from "../types/agent.ts";
import type { RollConfig } from "./schema.ts";

const ENV_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/;

type AgentEnvMap = RollConfig["agents"]["env"];

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
  return getAgentEnvFromAgentsConfig(config.agents, agentName);
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
