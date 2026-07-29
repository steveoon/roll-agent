import { defineCommand } from "citty";
import { loadAgentsConfig } from "../../config/loader.ts";
import {
  AGENT_USAGE_STOP_RECOVERY_STATUSES,
  inspectAgentUsageStopRecovery,
} from "../../registry/agent-usage-lease.ts";
import {
  getAgentLogPath,
  getAgentPid,
  inspectManagedAgentRuntime,
  probeAgentEndpoint,
} from "../../registry/process-manager.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

interface AgentHealthResult {
  readonly agentName: string;
  readonly transport: RegisteredAgent["transport"]["type"];
  readonly healthy: boolean;
  readonly message: string;
  readonly recovery?:
    | {
        readonly status: typeof AGENT_USAGE_STOP_RECOVERY_STATUSES.RECOVERABLE;
        readonly command: string;
      }
    | {
        readonly status: typeof AGENT_USAGE_STOP_RECOVERY_STATUSES.BLOCKED;
      };
}

export default defineCommand({
  meta: { description: "检查 Agent 健康状态（兼容 on-demand / core-managed / external-managed）" },
  args: {
    restart: {
      type: "boolean",
      description: "兼容旧参数；当前不会执行自动重启",
      default: false,
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const agents = store.list();

    if (args.restart) {
      log.warn("`--restart` 仅为兼容保留参数；v1 不执行自动重启逻辑。");
    }

    if (agents.length === 0) {
      if (args.json) {
        console.log("[]");
        return;
      }
      log.info("暂无已注册 Agent。");
      return;
    }

    const results: AgentHealthResult[] = [];
    for (const agent of agents) {
      results.push(await checkAgentHealth(agent, store, agentsConfig.dataDir));
    }

    const unhealthy = results.filter((result) => !result.healthy);

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      if (unhealthy.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    for (const result of results) {
      if (result.healthy) {
        log.success(`${result.agentName} [${result.transport}]: ${result.message}`);
      } else {
        log.error(`${result.agentName} [${result.transport}]: ${result.message}`);
      }
    }

    if (unhealthy.length > 0) {
      process.exitCode = 1;
    }
  },
});

async function checkAgentHealth(
  agent: RegisteredAgent,
  store: AgentStore,
  dataDir: string,
): Promise<AgentHealthResult> {
  switch (agent.runtime.ownership) {
    case "on-demand":
      return {
        agentName: agent.skill.name,
        transport: agent.transport.type,
        healthy: true,
        message: "按需模式：无需常驻进程，由 run/ask 在调用时启动",
      };
    case "external-managed":
      return checkExternalManagedHealth(agent, store);
    case "core-managed":
      return checkCoreManagedHealth(agent, store, dataDir);
  }
}

async function checkExternalManagedHealth(
  agent: RegisteredAgent,
  store: AgentStore,
): Promise<AgentHealthResult> {
  try {
    await probeAgentEndpoint(agent, { timeoutMs: 5_000 });
    store.updateStatus(agent.skill.name, "online");
    return {
      agentName: agent.skill.name,
      transport: agent.transport.type,
      healthy: true,
      message:
        agent.transport.type === "streamable-http"
          ? `外部服务可连接 (${agent.transport.endpoint})`
          : "外部服务可连接",
    };
  } catch (err) {
    store.updateStatus(agent.skill.name, "error");
    return {
      agentName: agent.skill.name,
      transport: agent.transport.type,
      healthy: false,
      message:
        agent.transport.type === "streamable-http"
          ? `外部服务不可连接 (${agent.transport.endpoint}): ${err instanceof Error ? err.message : String(err)}`
          : `外部服务不可连接: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkCoreManagedHealth(
  agent: RegisteredAgent,
  store: AgentStore,
  dataDir: string,
): Promise<AgentHealthResult> {
  try {
    const recoveryInspection = await inspectAgentUsageStopRecovery(agent, dataDir);
    if (recoveryInspection.status === AGENT_USAGE_STOP_RECOVERY_STATUSES.RECOVERABLE) {
      store.updateStatus(agent.skill.name, "error");
      const command = `roll agent stop ${agent.skill.name}`;
      return {
        agentName: agent.skill.name,
        transport: agent.transport.type,
        healthy: false,
        message:
          `检测到 ${String(recoveryInspection.releases.length)} 个上次停止中断留下的租约。` +
          `运行 \`${command}\` 确认恢复；非交互环境使用 \`${command} --recover\`。`,
        recovery: {
          status: AGENT_USAGE_STOP_RECOVERY_STATUSES.RECOVERABLE,
          command,
        },
      };
    }
    if (recoveryInspection.status === AGENT_USAGE_STOP_RECOVERY_STATUSES.BLOCKED) {
      store.updateStatus(agent.skill.name, "error");
      return {
        agentName: agent.skill.name,
        transport: agent.transport.type,
        healthy: false,
        message: `Agent 使用租约状态异常，无法安全自动恢复：${recoveryInspection.reason}`,
        recovery: {
          status: AGENT_USAGE_STOP_RECOVERY_STATUSES.BLOCKED,
        },
      };
    }
  } catch (error) {
    store.updateStatus(agent.skill.name, "error");
    return {
      agentName: agent.skill.name,
      transport: agent.transport.type,
      healthy: false,
      message: `无法检查 Agent 使用租约：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const pid = getAgentPid(dataDir, agent.skill.name);
  if (pid === undefined) {
    store.updateStatus(agent.skill.name, "stopped");
    return {
      agentName: agent.skill.name,
      transport: agent.transport.type,
      healthy: false,
      message: `未运行（缺少活动 PID）。日志: ${getAgentLogPath(dataDir, agent.skill.name)}`,
    };
  }

  const runtimeInspection = inspectManagedAgentRuntime(agent, dataDir);
  if (runtimeInspection.issues.length > 0) {
    store.updateStatus(agent.skill.name, "error");
    return {
      agentName: agent.skill.name,
      transport: agent.transport.type,
      healthy: false,
      message:
        `${runtimeInspection.issues.map((issue) => issue.message).join("；")}。` +
        `日志: ${getAgentLogPath(dataDir, agent.skill.name)}`,
    };
  }

  try {
    await probeAgentEndpoint(agent, { timeoutMs: 5_000 });
    store.updateStatus(agent.skill.name, "online");
    return {
      agentName: agent.skill.name,
      transport: agent.transport.type,
      healthy: true,
      message:
        agent.transport.type === "streamable-http"
          ? `运行中 (PID: ${String(pid)})，可连接 (${agent.transport.endpoint})`
          : `运行中 (PID: ${String(pid)})`,
    };
  } catch (err) {
    store.updateStatus(agent.skill.name, "error");
    return {
      agentName: agent.skill.name,
      transport: agent.transport.type,
      healthy: false,
      message:
        agent.transport.type === "streamable-http"
          ? `进程存在但不可连接 (${agent.transport.endpoint}): ${err instanceof Error ? err.message : String(err)}。日志: ${getAgentLogPath(dataDir, agent.skill.name)}`
          : `进程存在但不可连接: ${err instanceof Error ? err.message : String(err)}。日志: ${getAgentLogPath(dataDir, agent.skill.name)}`,
    };
  }
}
