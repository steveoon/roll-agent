import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";

export default defineCommand({
  meta: { description: "移除一个 Agent" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  run({ args }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
    const removed = store.remove(args.name);

    if (removed) {
      console.log(`✓ Agent "${args.name}" 已移除`);
    } else {
      console.error(`✗ Agent "${args.name}" 未找到`);
      process.exitCode = 1;
    }
  },
});
