import type { RegisteredAgent } from "../types/agent.ts";

/**
 * 声明式路由：按名称直接查找 Agent。
 *
 * 用于 `roll run <agent> <tool>` 场景，不涉及 LLM。
 */
export function resolveAgent(
  agentName: string,
  agents: ReadonlyArray<RegisteredAgent>,
): RegisteredAgent | undefined {
  return agents.find((a) => a.skill.name === agentName);
}
