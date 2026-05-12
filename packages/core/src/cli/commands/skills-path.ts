import { defineCommand } from "citty";
import { loadAgentsConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { resolveAgentSkillPath } from "./skills-utils.ts";

export default defineCommand({
  meta: { description: "输出指定 Agent 的 SKILL.md 文件路径" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
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

    const skillPath = resolveAgentSkillPath(agent);
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            name: agent.skill.name,
            source: skillPath ? "filesystem" : "registry",
            path: skillPath ?? null,
          },
          null,
          2,
        ),
      );
    } else if (skillPath) {
      console.log(skillPath);
    } else {
      console.error(`✗ Agent "${agent.skill.name}" 没有可用的本地 SKILL.md 文件`);
    }

    if (!skillPath) {
      process.exitCode = 1;
    }
  },
});
