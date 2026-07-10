import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  getAgentEnv,
  getMissingAgentEnvRuntimeIssues,
  inspectAgentEnvRequirements,
} from "../../config/helpers.ts";
import { shouldSkipRuntimeReadinessForTool } from "../../config/runtime-env.ts";
import { resolveLLMCall, toSamplingConnectOptions } from "../../llm/providers.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { AgentStore } from "../../registry/store.ts";
import { resolveTransportWithDevSpawnSpec } from "../../registry/dev-spawn.ts";
import { routeWithLLM } from "../../router/llm-router.ts";
import { extractToolInput } from "../../tool-runtime/argument-extractor.ts";
import { formatValidationIssuesMessage } from "../../tool-runtime/messages.ts";
import { preflightToolCall } from "../../tool-runtime/preflight.ts";
import type {
  AskCommandResult,
  AskFailedResult,
  AskNeedsConfirmationResult,
  AskNeedsInputResult,
  AskSuccessResult,
} from "../../types/ask.ts";
import { formatMissingToolMessage, normalizeListedTools } from "../utils/agent-tools.ts";
import { log, redactToolArgsForLog } from "../utils/output.ts";
import { extractTextContent, isToolErrorResult } from "../utils/tool-results.ts";

/** 默认确认阈值：低于此值时跳过执行 */
const DEFAULT_CONFIRM_THRESHOLD = 0.5;

function printAskJson(result: AskCommandResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function printSuccessText(result: AskSuccessResult): void {
  const texts = extractTextContent(
    typeof result.result === "object" && result.result !== null && "content" in result.result
      ? result.result.content
      : undefined,
  );
  for (const text of texts) {
    console.log(text);
  }
}

export default defineCommand({
  meta: { description: "用 LLM 从自然语言中选择 Agent 和 MCP tool" },
  args: {
    message: { type: "positional", description: "自然语言消息", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    verbose: { type: "boolean", alias: "v", description: "输出调试日志", default: false },
  },
  async run({ args }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
    const agents = store.list();

    if (agents.length === 0) {
      log.error(
        "暂无已注册的 Agent。可使用 `roll agent add <path>`、`roll agent install <package>` 或 `roll agent add --remote <endpoint>`。",
      );
      process.exitCode = 1;
      return;
    }

    const outputResult = (result: AskCommandResult): void => {
      if (args.json) {
        printAskJson(result);
        return;
      }

      switch (result.status) {
        case "success":
          printSuccessText(result);
          break;
        case "needs_input":
        case "needs_confirmation":
        case "failed":
          break;
      }
    };

    const routerProvider = config.llm.defaultProvider;
    const routerModelName = config.ask.llmModel ?? config.llm.defaultModel;
    const providerConfig = config.llm.providers[routerProvider];

    if (!providerConfig) {
      log.error(`LLM provider "${routerProvider}" 未配置。请检查 roll.config.yaml`);
      process.exitCode = 1;
      return;
    }

    const { model, providerOptions: structuredOutputProviderOptions } = resolveLLMCall(
      routerProvider,
      routerModelName,
      providerConfig.apiKey,
      "structured-output",
      providerConfig.baseUrl,
    );

    log.info(`分析意图: "${args.message}"`);
    let decision;
    try {
      decision = await routeWithLLM(args.message, agents, model, structuredOutputProviderOptions);
    } catch (err) {
      const result: AskFailedResult = {
        status: "failed",
        stage: "route",
        message: `LLM 路由失败: ${err instanceof Error ? err.message : String(err)}`,
      };
      log.error(result.message);
      outputResult(result);
      process.exitCode = 1;
      return;
    }

    log.info(
      `路由决策: ${decision.agentName}.${decision.toolName} (置信度: ${String(decision.confidence)})`,
    );

    const threshold = config.ask.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
    if (decision.confidence < threshold) {
      const result: AskNeedsConfirmationResult = {
        status: "needs_confirmation",
        decision,
        message:
          `置信度 ${String(decision.confidence)} 低于阈值 ${String(threshold)}，跳过执行。` +
          ` 可使用 \`roll run ${decision.agentName} ${decision.toolName}\` 手动调用。`,
      };
      log.warn(result.message);
      outputResult(result);
      process.exitCode = 1;
      return;
    }

    const agent = agents.find((item) => item.skill.name === decision.agentName);
    if (!agent) {
      const result: AskFailedResult = {
        status: "failed",
        stage: "route",
        decision,
        message: `Agent "${decision.agentName}" 未找到（LLM 返回了无效的 Agent 名称）`,
      };
      log.error(result.message);
      outputResult(result);
      process.exitCode = 1;
      return;
    }

    const samplingCall = resolveLLMCall(
      routerProvider,
      config.llm.defaultModel,
      providerConfig.apiKey,
      "sampling",
      providerConfig.baseUrl,
      config.runtime.thinkingLevel,
    );

    const clientManager = new McpClientManager();
    let failureStage: "connect" | "execute" = "connect";
    try {
      log.info(`连接 Agent "${agent.skill.name}"...`);
      const agentEnv = getAgentEnv(config, agent.skill.name);
      const transport = resolveTransportWithDevSpawnSpec(agent);
      const client = await clientManager.connect(agent.skill.name, transport, agent.installPath, {
        ...toSamplingConnectOptions(samplingCall),
        ...(agentEnv ? { env: agentEnv } : {}),
      });
      const tools = normalizeListedTools((await client.listTools()).tools);
      const targetTool = tools.find((tool) => tool.name === decision.toolName);

      if (!targetTool) {
        const result: AskFailedResult = {
          status: "failed",
          stage: "route",
          decision,
          message: formatMissingToolMessage(agent.skill.name, decision.toolName, tools),
        };
        log.error(result.message);
        outputResult(result);
        process.exitCode = 1;
        return;
      }

      failureStage = "execute";
      const extractedInput = await extractToolInput(
        args.message,
        targetTool,
        model,
        structuredOutputProviderOptions,
      );
      const finalDecision = { ...decision, input: extractedInput };

      const envReport = inspectAgentEnvRequirements(
        agent.skill.name,
        agent.skill.env,
        config.agents.env,
      );
      const runtimeIssues = shouldSkipRuntimeReadinessForTool(targetTool.name)
        ? []
        : getMissingAgentEnvRuntimeIssues(envReport);
      const preflightResult = preflightToolCall(targetTool, finalDecision.input, {
        runtimeIssues,
      });
      if (!preflightResult.ok) {
        const result: AskNeedsInputResult = {
          status: "needs_input",
          decision: finalDecision,
          validationIssues: preflightResult.issues,
          runtimeIssues: preflightResult.runtimeIssues,
          message: formatValidationIssuesMessage(
            agent.skill.name,
            decision.toolName,
            preflightResult.issues,
            preflightResult.runtimeIssues,
          ),
        };
        log.warn(result.message);
        outputResult(result);
        process.exitCode = 1;
        return;
      }

      log.info(`调用 ${agent.skill.name}.${decision.toolName}`);
      log.debug(`调用参数: ${JSON.stringify(redactToolArgsForLog(finalDecision.input))}`);
      const toolResult = await client.callTool({
        name: decision.toolName,
        arguments: finalDecision.input,
      });

      if (isToolErrorResult(toolResult)) {
        const message = extractTextContent(toolResult.content).join("\n") || "Tool 调用失败";
        const result: AskFailedResult = {
          status: "failed",
          stage: "execute",
          decision: finalDecision,
          message,
        };
        log.error(result.message);
        outputResult(result);
        process.exitCode = 1;
        return;
      }

      const result: AskSuccessResult = {
        status: "success",
        decision: finalDecision,
        result: toolResult,
      };
      outputResult(result);
      log.success("调用完成");
    } catch (err) {
      const result: AskFailedResult = {
        status: "failed",
        stage: failureStage,
        decision,
        message: err instanceof Error ? err.message : String(err),
      };
      log.error(result.message);
      outputResult(result);
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});
