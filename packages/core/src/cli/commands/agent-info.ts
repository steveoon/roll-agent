import { defineCommand } from "citty";
import {
  getAgentEnv,
  getAgentEnvFromAgentsConfig,
  inspectAgentEnvRequirements,
} from "../../config/helpers.ts";
import {
  formatAgentEnvDeclarationSource,
  formatAgentEnvRuntimeStatus,
  formatAgentRuntimeVerification,
  inspectAgentRuntimeEnvRequirements,
} from "../../config/runtime-env.ts";
import { loadAgentsConfig, loadConfig } from "../../config/loader.ts";
import { inspectAgentRuntimeEnv } from "../../mcp/agent-diagnostics.ts";
import {
  formatAgentSourceType,
  getAgentLocation,
  inferAgentSourceType,
} from "../../registry/source.ts";
import { AgentStore } from "../../registry/store.ts";

export default defineCommand({
  meta: { description: "查看 Agent 详情" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  async run({ args }) {
    const { agentsConfig } = loadAgentsConfig();
    const store = new AgentStore(agentsConfig.dataDir);
    const agent = store.findByName(args.name);

    if (!agent) {
      console.error(`✗ Agent "${args.name}" 未找到`);
      process.exitCode = 1;
      return;
    }

    console.log(`名称:     ${agent.skill.name}`);
    console.log(`描述:     ${agent.skill.description}`);
    console.log(`状态:     ${agent.status}`);
    console.log(`来源:     ${formatAgentSourceType(inferAgentSourceType(agent))}`);
    console.log(`传输:     ${agent.transport.type}`);
    console.log(`位置:     ${getAgentLocation(agent)}`);
    console.log(`注册时间: ${agent.registeredAt}`);

    if (agent.source?.type === "installed-package") {
      console.log(`安装包:   ${agent.source.packageSpec}`);
      console.log(`安装目录: ${agent.source.installDir}`);
    }

    if (Object.keys(agent.skill.metadata).length > 0) {
      console.log(`元数据:`);
      for (const [key, value] of Object.entries(agent.skill.metadata)) {
        console.log(`  ${key}: ${value}`);
      }
    }

    const config = tryLoadFullConfig();
    const envReport = inspectAgentEnvRequirements(
      agent.skill.name,
      agent.skill.env,
      agentsConfig.env,
    );
    if (envReport) {
      const runtimeInspection = await inspectAgentRuntimeEnv(
        agent,
        config !== undefined ? { config } : { agentsConfig },
      );
      const runtimeReport = inspectAgentRuntimeEnvRequirements(
        envReport,
        config !== undefined
          ? getAgentEnv(config, agent.skill.name)
          : getAgentEnvFromAgentsConfig(agentsConfig, agent.skill.name),
        runtimeInspection,
      );

      console.log(`环境变量:`);
      console.log(`  运行态校验: ${formatAgentRuntimeVerification(runtimeReport)}`);
      for (const item of runtimeReport.items) {
        const status = formatAgentEnvDeclarationSource(item);
        const level = item.required ? "必填" : "可选";
        const runtimeStatus = formatAgentEnvRuntimeStatus(item);
        console.log(
          `  ${item.name}: [${level}] ${status}${runtimeStatus ? `；运行态: ${runtimeStatus}` : ""}`,
        );
        if (item.purpose) {
          console.log(`    用途: ${item.purpose}`);
        }
      }
    }
  },
});

function tryLoadFullConfig(): ReturnType<typeof loadConfig>["config"] | undefined {
  try {
    return loadConfig().config;
  } catch {
    return undefined;
  }
}
