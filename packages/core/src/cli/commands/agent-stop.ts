import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";

export default defineCommand({
  meta: { description: "停止 Agent（stdio 无需手动停止）" },
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

    if (agent.transport.type === "stdio") {
      console.error(
        `✗ Agent "${args.name}" 使用 stdio 传输，生命周期由 run/ask 按需管理，` +
          "不支持手动 stop。",
      );
      process.exitCode = 1;
      return;
    }

    console.error(
      `✗ Agent "${args.name}" 使用 streamable-http 传输，需在外部服务中停止。` +
        `\n  端点: ${agent.transport.endpoint}`,
    );
    process.exitCode = 1;
  },
});
