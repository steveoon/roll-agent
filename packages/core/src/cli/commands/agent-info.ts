import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
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
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
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

    if (agent.source?.type === "installed") {
      console.log(`安装包:   ${agent.source.packageSpec}`);
      console.log(`安装目录: ${agent.source.installDir}`);
    }

    if (Object.keys(agent.skill.metadata).length > 0) {
      console.log(`元数据:`);
      for (const [key, value] of Object.entries(agent.skill.metadata)) {
        console.log(`  ${key}: ${value}`);
      }
    }
  },
});
