import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { startAgent } from "../../registry/process-manager.ts";

export default defineCommand({
  meta: { description: "启动一个 Agent（后台运行）" },
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

    try {
      const pid = startAgent(agent, config.agents.dataDir);
      store.updateStatus(args.name, "online");
      console.log(`✓ Agent "${args.name}" 已启动 (PID: ${String(pid)})`);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  },
});
