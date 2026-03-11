import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { stopAgent } from "../../registry/process-manager.ts";

export default defineCommand({
  meta: { description: "停止一个 Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  run({ args }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);

    if (!store.findByName(args.name)) {
      console.error(`✗ Agent "${args.name}" 未找到`);
      process.exitCode = 1;
      return;
    }

    const stopped = stopAgent(config.agents.dataDir, args.name);

    if (stopped) {
      store.updateStatus(args.name, "stopped");
      console.log(`✓ Agent "${args.name}" 已停止`);
    } else {
      console.error(`✗ Agent "${args.name}" 未在运行`);
      process.exitCode = 1;
    }
  },
});
