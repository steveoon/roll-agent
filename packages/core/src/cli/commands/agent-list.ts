import { defineCommand } from "citty";
import Table from "cli-table3";
import { loadConfig } from "../../config/loader.ts";
import {
  formatAgentSourceType,
  getAgentLocation,
  inferAgentSourceType,
} from "../../registry/source.ts";
import { AgentStore } from "../../registry/store.ts";

export default defineCommand({
  meta: { description: "列出所有已注册 Agent" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  run({ args }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
    const agents = store.list();

    if (agents.length === 0) {
      console.log(
        "暂无已注册的 Agent。可使用 `roll agent add <path>`、`roll agent install <package>` 或 `roll agent add --remote <endpoint>`。",
      );
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }

    const table = new Table({
      head: ["Name", "Status", "Source", "Transport", "Location"],
      style: { head: ["cyan"] },
    });

    for (const agent of agents) {
      table.push([
        agent.skill.name,
        agent.status,
        formatAgentSourceType(inferAgentSourceType(agent)),
        agent.transport.type,
        getAgentLocation(agent),
      ]);
    }

    console.log(table.toString());
  },
});
