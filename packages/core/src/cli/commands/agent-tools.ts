import { defineCommand } from "citty";
import { getAgentEnvFromAgentsConfig } from "../../config/helpers.ts";
import { loadAgentsConfig } from "../../config/loader.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { resolveTransportWithDevSpawnSpec } from "../../registry/dev-spawn.ts";
import { AgentStore } from "../../registry/store.ts";
import { normalizeListedTools } from "../utils/agent-tools.ts";
import { formatAgentToolsTextOutput } from "../utils/agent-tools-output.ts";
import { log } from "../utils/output.ts";

export default defineCommand({
  meta: { description: "查看 Agent 暴露的 MCP tools 及输入 schema" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const agent = store.findByName(args.name);

    if (!agent) {
      log.error(`Agent "${args.name}" 未找到。使用 \`roll agent list\` 查看已注册 Agent。`);
      process.exitCode = 1;
      return;
    }

    const clientManager = new McpClientManager();
    try {
      log.info(`连接 Agent "${agent.skill.name}" 并获取 MCP tools/list...`);
      const transport = resolveTransportWithDevSpawnSpec(agent);
      const agentEnv = getAgentEnvFromAgentsConfig(agentsConfig, agent.skill.name);
      const client = await clientManager.connect(agent.skill.name, transport, agent.installPath, {
        ...(agentEnv ? { env: agentEnv } : {}),
      });
      const { tools } = await client.listTools();
      const normalizedTools = normalizeListedTools(tools);

      if (args.json) {
        console.log(JSON.stringify(normalizedTools, null, 2));
        return;
      }

      if (normalizedTools.length === 0) {
        console.log(`Agent "${agent.skill.name}" 暂未暴露任何 tool。`);
        return;
      }

      console.log(formatAgentToolsTextOutput(agent.skill.name, normalizedTools));
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});
