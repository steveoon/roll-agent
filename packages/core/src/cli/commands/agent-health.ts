import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { log } from "../utils/output.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

type StreamableHttpAgent = RegisteredAgent & {
  readonly transport: Extract<RegisteredAgent["transport"], { readonly type: "streamable-http" }>;
};

interface AgentHealthResult {
  readonly agentName: string;
  readonly transport: RegisteredAgent["transport"]["type"];
  readonly healthy: boolean;
  readonly message: string;
}

function isStreamableHttpAgent(agent: RegisteredAgent): agent is StreamableHttpAgent {
  return agent.transport.type === "streamable-http";
}

export default defineCommand({
  meta: { description: "检查 Agent 健康状态（stdio 为按需模式）" },
  args: {
    restart: {
      type: "boolean",
      description: "兼容旧参数，stdio 按需模式下不生效",
      default: false,
    },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
    const agents = store.list();

    if (args.restart) {
      log.warn("`--restart` 仅为兼容保留参数；stdio Agent 为按需启动，不执行重启逻辑。");
    }

    if (agents.length === 0) {
      log.info("暂无已注册 Agent。");
      return;
    }

    const results: AgentHealthResult[] = [];
    for (const agent of agents) {
      if (!isStreamableHttpAgent(agent)) {
        results.push({
          agentName: agent.skill.name,
          transport: "stdio",
          healthy: true,
          message: "按需模式：由 run/ask 自动启动并在调用后释放",
        });
        continue;
      }

      results.push(await checkStreamableHttpHealth(agent));
    }

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    for (const result of results) {
      if (result.healthy) {
        log.success(`${result.agentName} [${result.transport}]: ${result.message}`);
      } else {
        log.error(`${result.agentName} [${result.transport}]: ${result.message}`);
      }
    }

    const unhealthy = results.filter((r) => !r.healthy);
    if (unhealthy.length > 0) {
      process.exitCode = 1;
    }
  },
});

async function checkStreamableHttpHealth(agent: StreamableHttpAgent): Promise<AgentHealthResult> {
  const clientManager = new McpClientManager();

  try {
    const client = await clientManager.connect(
      agent.skill.name,
      agent.transport,
      agent.installPath,
      { timeoutMs: 5000 },
    );
    await client.listTools();

    return {
      agentName: agent.skill.name,
      transport: "streamable-http",
      healthy: true,
      message: `可连接 (${agent.transport.endpoint})`,
    };
  } catch (err) {
    return {
      agentName: agent.skill.name,
      transport: "streamable-http",
      healthy: false,
      message: `不可连接 (${agent.transport.endpoint}): ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await clientManager.disconnectAll();
  }
}
