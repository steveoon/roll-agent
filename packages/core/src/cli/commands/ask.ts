import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { routeWithLLM } from "../../router/llm-router.ts";
import { createProviderModel } from "../../llm/providers.ts";

/** 默认确认阈值：低于此值时跳过执行 */
const DEFAULT_CONFIRM_THRESHOLD = 0.5;

export default defineCommand({
  meta: { description: "LLM 智能路由，自动选择 Agent 和 tool" },
  args: {
    message: { type: "positional", description: "自然语言消息", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
    const agents = store.list();

    if (agents.length === 0) {
      console.error("✗ 暂无已注册的 Agent。使用 `roll agent add <path>` 注册。");
      process.exitCode = 1;
      return;
    }

    // 1. 确定路由用的 LLM model
    const routerProvider = config.llm.defaultProvider;
    const routerModelName = config.router.llmModel ?? config.llm.defaultModel;
    const providerConfig = config.llm.providers[routerProvider];

    if (!providerConfig) {
      console.error(`✗ LLM provider "${routerProvider}" 未配置。请检查 roll.config.yaml`);
      process.exitCode = 1;
      return;
    }

    const model = createProviderModel(routerProvider, routerModelName, providerConfig.apiKey);

    // 2. LLM 智能路由
    console.error(`→ 分析意图: "${args.message}"`);
    let decision;
    try {
      decision = await routeWithLLM(args.message, agents, model);
    } catch (err) {
      console.error(`✗ LLM 路由失败: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    console.error(`→ 路由决策: ${decision.agentName}.${decision.toolName} (置信度: ${String(decision.confidence)})`);

    // 3. 置信度检查
    const threshold = config.router.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
    if (decision.confidence < threshold) {
      console.error(
        `✗ 置信度 ${String(decision.confidence)} 低于阈值 ${String(threshold)}，跳过执行。` +
          `\n  可使用 \`roll run ${decision.agentName} ${decision.toolName}\` 手动调用。`,
      );
      if (args.json) {
        console.log(JSON.stringify(decision, null, 2));
      }
      process.exitCode = 1;
      return;
    }

    // 4. 查找 Agent 并执行
    const agent = agents.find((a) => a.skill.name === decision.agentName);
    if (!agent) {
      console.error(`✗ Agent "${decision.agentName}" 未找到（LLM 返回了无效的 Agent 名称）`);
      process.exitCode = 1;
      return;
    }

    const clientManager = new McpClientManager();
    try {
      console.error(`→ 连接 Agent "${agent.skill.name}"...`);
      const client = await clientManager.connect(
        agent.skill.name,
        agent.transport,
        agent.installPath,
      );

      console.error(`→ 调用 ${agent.skill.name}.${decision.toolName}(${JSON.stringify(decision.input)})`);
      const result = await client.callTool({
        name: decision.toolName,
        arguments: decision.input,
      });

      if (args.json) {
        console.log(JSON.stringify({ decision, result }, null, 2));
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

      console.error("✓ 调用完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${message}`);
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});
