import type { RollConfig } from "./schema.ts";

function toCamelCaseKey(value: string): string {
  return value.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** 获取指定 Agent 的环境变量配置，没有则返回 undefined */
export function getAgentEnv(
  config: RollConfig,
  agentName: string,
): Readonly<Record<string, string>> | undefined {
  const envMap = config.agents.env;
  if (!envMap) {
    return undefined;
  }

  const exactMatch = envMap[agentName];
  if (exactMatch) {
    return exactMatch;
  }

  return envMap[toCamelCaseKey(agentName)];
}
