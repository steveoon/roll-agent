import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { getAgentEnv } from "../../config/schema.ts";
import { AgentStore } from "../../registry/store.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { createProviderModel } from "../../llm/providers.ts";
import { log } from "../utils/output.ts";

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
      log.error(`Agent "${args.agent}" 未注册。使用 \`roll agent list\` 查看已注册 Agent。`);
      process.exitCode = 1;
      return;
    }

    // 2. 解析额外参数 (--key value 格式)
    const toolArgs = parseToolArgs(rawArgs);

    // 3. 连接 MCP Server
    const clientManager = new McpClientManager();
    try {
      // 尝试创建 Sampling model（为子 Agent 提供 LLM 能力）
      const providerName = config.llm.defaultProvider;
      const providerConfig = config.llm.providers[providerName];
      const samplingModel = providerConfig
        ? createProviderModel(
            providerName,
            config.llm.defaultModel,
            providerConfig.apiKey,
            providerConfig.baseUrl,
          )
        : undefined;

      log.info(`连接 Agent "${agent.skill.name}"...`);
      const agentEnv = getAgentEnv(config, agent.skill.name);
      const client = await clientManager.connect(
        agent.skill.name,
        agent.transport,
        agent.installPath,
        { ...(samplingModel ? { samplingModel } : {}), ...(agentEnv ? { env: agentEnv } : {}) },
      );

      // 4. 列出 tools 验证目标 tool 存在
      const { tools } = await client.listTools();
      const targetTool = tools.find((t) => t.name === args.tool);
      if (!targetTool) {
        const available = tools.map((t) => t.name).join(", ");
        log.error(`Tool "${args.tool}" 不存在。可用 tools: ${available}`);
        process.exitCode = 1;
        return;
      }

      // 5. 调用 tool
      log.info(`调用 ${agent.skill.name}.${args.tool}(${JSON.stringify(toolArgs)})`);
      const result = await client.callTool({
        name: args.tool,
        arguments: toolArgs,
      });

      // 6. 输出结果（stdout，不经过 log）
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (Array.isArray(result.content)) {
        for (const content of result.content) {
          if (
            typeof content === "object" &&
            content !== null &&
            "type" in content &&
            content.type === "text" &&
            "text" in content &&
            typeof content.text === "string"
          ) {
            console.log(content.text);
          }
        }
      }

      log.success("调用完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause ? `\n  cause: ${String(err.cause)}` : "";
      log.error(`${message}${cause}`);
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});

/** run 命令的 CLI 保留参数（不应透传给 tool） */
const CLI_FLAG_OPTIONS = new Set(["json", "verbose", "v", "help", "h", "version"]);
const CLI_VALUE_OPTIONS = new Set(["config"]);

/**
 * 从 rawArgs 中解析 --key value 格式的参数。
 * 支持 --limit 10（数字自动转换）和 --dryRun（布尔标志）。
 */
export function parseToolArgs(rawArgs: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // 跳过前面的 positional args（agent 和 tool 名称）
  let i = 0;
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

    // 跳过 run 命令自身参数，避免污染 tool input
    if (CLI_FLAG_OPTIONS.has(key)) {
      i++;
      continue;
    }

    if (CLI_VALUE_OPTIONS.has(key)) {
      i += nextArg && !nextArg.startsWith("--") ? 2 : 1;
      continue;
    }

    if (!nextArg || nextArg.startsWith("--")) {
      result[key] = true;
      i++;
    } else {
      const num = Number(nextArg);
      result[key] = Number.isNaN(num) ? nextArg : num;
      i += 2;
    }
  }

  return result;
}
