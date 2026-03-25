import { defineCommand } from "citty";
import { loadAgentsConfig } from "../../config/loader.ts";
import { inspectAgentEnvRequirements } from "../../config/helpers.ts";
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
  run({ args }) {
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

    const envReport = inspectAgentEnvRequirements(
      agent.skill.name,
      agent.skill.env,
      agentsConfig.env,
    );
    if (envReport) {
      console.log(`环境变量:`);
      for (const item of envReport.items) {
        const status =
          item.source === "agents.env"
            ? "已配置于 agents.env"
            : item.source === "process.env"
              ? "仅当前 shell 环境"
              : item.source === "default"
                ? `默认值 (${item.default})`
                : "缺失";
        const level = item.required ? "必填" : "可选";
        console.log(`  ${item.name}: [${level}] ${status}`);
        if (item.purpose) {
          console.log(`    用途: ${item.purpose}`);
        }
      }
    }
  },
});
