import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";

export default defineCommand({
  meta: { description: "检查 Agent 是否可连接（stdio 无需手动启动）" },
  args: {
    name: { type: "positional", description: "Agent 名称", required: true },
  },
  async run({ args }) {
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
          "不支持手动 start。",
      );
      process.exitCode = 1;
      return;
    }

    // streamable-http 由外部服务管理；start 命令仅做可达性探测
    const clientManager = new McpClientManager();
    try {
      const client = await clientManager.connect(
        agent.skill.name,
        agent.transport,
        agent.installPath,
        { timeoutMs: 5000 },
      );
      await client.listTools();
      console.log(
        `✓ Agent "${args.name}" 可连接 (${agent.transport.endpoint})。` +
          "该 Agent 需由外部进程管理启动。",
      );
    } catch (err) {
      console.error(
        `✗ Agent "${args.name}" 不可连接 (${agent.transport.endpoint})。` +
          "请先在外部启动服务。",
      );
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});
