import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";

export default defineCommand({
  meta: { description: "声明式调用 Agent 的指定 tool" },
  args: {
    agent: { type: "positional", description: "Agent 名称", required: true },
    tool: { type: "positional", description: "Tool 名称", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args, rawArgs }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);

    // 1. 查找已注册的 Agent
    const agent = store.findByName(args.agent);
    if (!agent) {
      console.error(`✗ Agent "${args.agent}" 未注册。使用 \`roll agent list\` 查看已注册 Agent。`);
      process.exitCode = 1;
      return;
    }

    // 2. 解析额外参数 (--key value 格式)
    const toolArgs = parseToolArgs(rawArgs);

    // 3. 连接 MCP Server
    const clientManager = new McpClientManager();
    try {
      console.error(`→ 连接 Agent "${agent.skill.name}"...`);
      const client = await clientManager.connect(
        agent.skill.name,
        agent.transport,
        agent.installPath,
      );

      // 4. 列出 tools 验证目标 tool 存在
      const { tools } = await client.listTools();
      const targetTool = tools.find((t) => t.name === args.tool);
      if (!targetTool) {
        const available = tools.map((t) => t.name).join(", ");
        console.error(`✗ Tool "${args.tool}" 不存在。可用 tools: ${available}`);
        process.exitCode = 1;
        return;
      }

      // 5. 调用 tool
      console.error(`→ 调用 ${agent.skill.name}.${args.tool}(${JSON.stringify(toolArgs)})`);
      const result = await client.callTool({
        name: args.tool,
        arguments: toolArgs,
      });

      // 6. 输出结果
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const content of result.content as Array<{ type: string; text?: string }>) {
          if (content.type === "text" && content.text) {
            console.log(content.text);
          }
        }
      }

      console.error("✓ 调用完成");
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});

/**
 * 从 rawArgs 中解析 --key value 格式的参数。
 * 支持 --limit 10（数字自动转换）和 --dryRun（布尔标志）。
 */
function parseToolArgs(rawArgs: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // 跳过前面的 positional args（agent 和 tool 名称）
  let i = 0;
  // 跳过非 -- 开头的参数
  while (i < rawArgs.length && !rawArgs[i]?.startsWith("--")) {
    i++;
  }

  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (!arg?.startsWith("--")) {
      i++;
      continue;
    }

    const key = arg.slice(2);
    const nextArg = rawArgs[i + 1];

    // 如果下一个参数不存在或以 -- 开头，当作布尔标志
    if (!nextArg || nextArg.startsWith("--")) {
      result[key] = true;
      i++;
    } else {
      // 尝试转换数字
      const num = Number(nextArg);
      result[key] = Number.isNaN(num) ? nextArg : num;
      i += 2;
    }
  }

  return result;
}
