import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { AgentStore } from "../../registry/store.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { routeWithLLM } from "../../router/llm-router.ts";
import { createProviderModel } from "../../llm/providers.ts";
import { log } from "../utils/output.ts";

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
      log.error("暂无已注册的 Agent。使用 `roll agent add <path>` 注册。");
      process.exitCode = 1;
      return;
    }

    // 1. 确定路由用的 LLM model
    const routerProvider = config.llm.defaultProvider;
    const routerModelName = config.router.llmModel ?? config.llm.defaultModel;
    const providerConfig = config.llm.providers[routerProvider];

    if (!providerConfig) {
      log.error(`LLM provider "${routerProvider}" 未配置。请检查 roll.config.yaml`);
      process.exitCode = 1;
      return;
    }

    const model = createProviderModel(routerProvider, routerModelName, providerConfig.apiKey);

    // 2. LLM 智能路由
    log.info(`分析意图: "${args.message}"`);
    let decision;
    try {
      decision = await routeWithLLM(args.message, agents, model);
    } catch (err) {
      log.error(`LLM 路由失败: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    log.info(`路由决策: ${decision.agentName}.${decision.toolName} (置信度: ${String(decision.confidence)})`);

    // 3. 置信度检查
    const threshold = config.router.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
    if (decision.confidence < threshold) {
      log.warn(
        `置信度 ${String(decision.confidence)} 低于阈值 ${String(threshold)}，跳过执行。` +
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
      log.error(`Agent "${decision.agentName}" 未找到（LLM 返回了无效的 Agent 名称）`);
      process.exitCode = 1;
      return;
    }

    // 为子 Agent 创建 Sampling model（复用路由用的 LLM model）
    const samplingModel = createProviderModel(
      routerProvider,
      config.llm.defaultModel,
      providerConfig.apiKey,
    );

    const clientManager = new McpClientManager();
    try {
      log.info(`连接 Agent "${agent.skill.name}"...`);
      const client = await clientManager.connect(
        agent.skill.name,
        agent.transport,
        agent.installPath,
        { samplingModel },
      );

      log.info(`调用 ${agent.skill.name}.${decision.toolName}(${JSON.stringify(decision.input)})`);
      const result = await client.callTool({
        name: decision.toolName,
        arguments: decision.input,
      });

      // 数据结果输出到 stdout
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

      log.success("调用完成");
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});
