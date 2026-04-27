import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  getAgentEnv,
  getMissingAgentEnvRuntimeIssues,
  inspectAgentEnvRequirements,
} from "../../config/helpers.ts";
import { AgentStore } from "../../registry/store.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { resolveTransportWithDevSpawnSpec } from "../../registry/dev-spawn.ts";
import { createProviderModel } from "../../llm/providers.ts";
import { formatValidationIssuesMessage } from "../../tool-runtime/messages.ts";
import { preflightToolCall } from "../../tool-runtime/preflight.ts";
import { formatMissingToolMessage, normalizeListedTools } from "../utils/agent-tools.ts";
import {
  extractTextContent,
  formatToolResultForJsonOutput,
  isToolErrorResult,
} from "../utils/tool-results.ts";
import { log, redactToolArgsForLog } from "../utils/output.ts";
import { shouldSkipRuntimeReadinessForTool } from "../../config/runtime-env.ts";

export default defineCommand({
  meta: { description: "声明式调用 Agent 的指定 tool" },
  args: {
    agent: { type: "positional", description: "Agent 名称", required: true },
    tool: { type: "positional", description: "Tool 名称", required: true },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    verbose: { type: "boolean", alias: "v", description: "输出调试日志", default: false },
    "input-json": { type: "string", description: "以 JSON 字符串提供完整 tool 输入对象" },
    "input-file": { type: "string", description: "从 JSON 文件读取完整 tool 输入对象" },
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
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = resolveToolArgs(rawArgs);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

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
      const transport = resolveTransportWithDevSpawnSpec(agent);
      const client = await clientManager.connect(
        agent.skill.name,
        transport,
        agent.installPath,
        { ...(samplingModel ? { samplingModel } : {}), ...(agentEnv ? { env: agentEnv } : {}) },
      );

      // 4. 列出 tools 验证目标 tool 存在
      const tools = normalizeListedTools((await client.listTools()).tools);
      const targetTool = tools.find((tool) => tool.name === args.tool);
      if (!targetTool) {
        log.error(formatMissingToolMessage(agent.skill.name, args.tool, tools));
        process.exitCode = 1;
        return;
      }

      const envReport = inspectAgentEnvRequirements(
        agent.skill.name,
        agent.skill.env,
        config.agents.env,
      );
      const runtimeIssues = shouldSkipRuntimeReadinessForTool(targetTool.name)
        ? []
        : getMissingAgentEnvRuntimeIssues(envReport);
      const preflightResult = preflightToolCall(targetTool, toolArgs, {
        runtimeIssues,
      });
      if (!preflightResult.ok) {
        log.error(
          formatValidationIssuesMessage(
            agent.skill.name,
            args.tool,
            preflightResult.issues,
            preflightResult.runtimeIssues,
          ),
        );
        process.exitCode = 1;
        return;
      }

      // 5. 调用 tool
      log.info(`调用 ${agent.skill.name}.${args.tool}`);
      log.debug(`调用参数: ${JSON.stringify(redactToolArgsForLog(toolArgs))}`);
      const result = await client.callTool({
        name: args.tool,
        arguments: toolArgs,
      });

      // 6. 输出结果（stdout，不经过 log）
      if (args.json) {
        console.log(JSON.stringify(formatToolResultForJsonOutput(result), null, 2));
      } else {
        for (const text of extractTextContent(result.content)) {
          console.log(text);
        }
      }

      if (isToolErrorResult(result)) {
        log.error("tool 返回 isError=true");
        process.exitCode = 1;
        return;
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
const CLI_VALUE_OPTIONS = new Set(["config", "input-json", "input-file"]);

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObjectInput(source: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(
      `${context} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isRecordObject(parsed)) {
    throw new Error(`${context} 必须是 JSON object`);
  }

  return parsed;
}

function getCliValueOption(rawArgs: string[], optionName: string): string | undefined {
  let i = 0;
  while (i < rawArgs.length && !rawArgs[i]?.startsWith("--")) {
    i++;
  }

  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg !== `--${optionName}`) {
      i++;
      continue;
    }

    const nextArg = rawArgs[i + 1];
    if (!nextArg || nextArg.startsWith("--")) {
      throw new Error(`选项 --${optionName} 需要提供值`);
    }

    return nextArg;
  }

  return undefined;
}

export function parseExplicitToolInput(rawArgs: string[]): Record<string, unknown> | undefined {
  const inputJson = getCliValueOption(rawArgs, "input-json");
  const inputFile = getCliValueOption(rawArgs, "input-file");
  const positionalJson = getPositionalJsonInput(rawArgs);

  const explicitInputCount = [inputJson, inputFile, positionalJson].filter(
    (value) => value !== undefined,
  ).length;
  if (explicitInputCount > 1) {
    throw new Error("不能同时使用 positional JSON、--input-json 和 --input-file");
  }

  if (inputJson) {
    return parseJsonObjectInput(inputJson, "--input-json");
  }

  if (inputFile) {
    const fileContent = readFileSync(inputFile, "utf-8");
    return parseJsonObjectInput(fileContent, `输入文件 ${inputFile}`);
  }

  if (positionalJson) {
    return parseJsonObjectInput(positionalJson, "positional JSON input");
  }

  return undefined;
}

function getPositionalJsonInput(rawArgs: string[]): string | undefined {
  const leadingPositionals: string[] = [];

  for (const arg of rawArgs) {
    if (arg.startsWith("--")) {
      break;
    }
    leadingPositionals.push(arg);
  }

  const extraPositionals = leadingPositionals.slice(2);
  if (extraPositionals.length === 0) {
    return undefined;
  }

  if (extraPositionals.length === 1 && extraPositionals[0]?.trim().startsWith("{")) {
    return extraPositionals[0];
  }

  throw new Error(
    "roll run 只接受 agent/tool 两个位置参数；tool 输入请使用 --key value、--input-json、--input-file，或第三个位置参数 JSON object",
  );
}

export function resolveToolArgs(rawArgs: string[]): Record<string, unknown> {
  const explicitInput = parseExplicitToolInput(rawArgs) ?? {};
  const flagInput = parseToolArgs(rawArgs);
  return { ...explicitInput, ...flagInput };
}

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
