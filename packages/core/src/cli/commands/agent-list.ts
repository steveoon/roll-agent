import { defineCommand } from "citty";
import Table from "cli-table3";
import { loadConfig } from "../../config/loader.ts";
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
      console.log("暂无已注册的 Agent。使用 `roll agent add <path>` 注册。");
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }

    const table = new Table({
      head: ["Name", "Status", "Transport", "Path"],
      style: { head: ["cyan"] },
    });

    for (const agent of agents) {
      table.push([
        agent.skill.name,
        agent.status,
        agent.transport.type,
        agent.installPath,
      ]);
    }

    console.log(table.toString());
  },
});
