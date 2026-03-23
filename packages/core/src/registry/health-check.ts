import { getAgentPid, startAgent } from "./process-manager.ts";
import type { AgentStore } from "./store.ts";
import type { RegisteredAgent } from "../types/agent.ts";

/** 健康检查结果 */
export interface HealthCheckResult {
  readonly agentName: string;
  readonly healthy: boolean;
  readonly restarted: boolean;
  readonly message: string;
}

/**
 * 检查所有状态为 "online" 的 Agent 是否仍在运行。
 *
 * - 如果进程已死且 autoRestart 为 true，尝试自动重启
 * - 更新 store 中的 Agent 状态
 */
export function checkAgentHealth(
  store: AgentStore,
  dataDir: string,
  options: {
    readonly autoRestart: boolean;
    readonly agentEnvMap?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  } = { autoRestart: false },
): ReadonlyArray<HealthCheckResult> {
  const agents = store.list();
  const results: HealthCheckResult[] = [];

  for (const agent of agents) {
    // 只检查 stdio 模式且预期在线的 Agent
    if (agent.transport.type !== "stdio" || agent.status !== "online") {
      continue;
    }

    const pid = getAgentPid(dataDir, agent.skill.name);

    if (pid !== undefined) {
      results.push({
        agentName: agent.skill.name,
        healthy: true,
        restarted: false,
        message: `运行中 (PID: ${String(pid)})`,
      });
      continue;
    }

    // 进程已死
    if (options.autoRestart) {
      const restarted = tryRestart(agent, store, dataDir, options.agentEnvMap?.[agent.skill.name]);
      results.push(restarted);
    } else {
      store.updateStatus(agent.skill.name, "error");
      results.push({
        agentName: agent.skill.name,
        healthy: false,
        restarted: false,
        message: "进程已退出，状态更新为 error",
      });
    }
  }

  return results;
}

/** 尝试重启 Agent */
function tryRestart(
  agent: RegisteredAgent,
  store: AgentStore,
  dataDir: string,
  env?: Readonly<Record<string, string>>,
): HealthCheckResult {
  try {
    const newPid = startAgent(agent, dataDir, env);
    store.updateStatus(agent.skill.name, "online");
    return {
      agentName: agent.skill.name,
      healthy: true,
      restarted: true,
      message: `已自动重启 (PID: ${String(newPid)})`,
    };
  } catch (err) {
    store.updateStatus(agent.skill.name, "error");
    return {
      agentName: agent.skill.name,
      healthy: false,
      restarted: false,
      message: `重启失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
