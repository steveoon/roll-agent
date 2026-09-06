import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  getAgentEnv,
  type AgentEnvCheckReport,
  getMissingAgentEnvRuntimeIssues,
  inspectAgentEnvRequirements,
} from "../../config/helpers.ts";
import { AgentStore } from "../../registry/store.ts";
import { ManagedAgentConnectionScope } from "../../mcp/managed-agent-connection.ts";
import {
  resolveLLMCall,
  toSamplingConnectOptions,
  type ResolvedLLMCall,
} from "../../llm/providers.ts";
import { formatValidationIssuesMessage } from "../../tool-runtime/messages.ts";
import { preflightToolCall } from "../../tool-runtime/preflight.ts";
import {
  formatMissingToolMessage,
  formatToolSchemaIssue,
  normalizeListedTools,
} from "../utils/agent-tools.ts";
import {
  extractTextContent,
  formatToolResultForJsonOutput,
  isToolErrorResult,
} from "../utils/tool-results.ts";
import { log, redactToolArgsForLog } from "../utils/output.ts";
import { shouldSkipRuntimeReadinessForTool } from "../../config/runtime-env.ts";
import type { AgentTool, RegisteredAgent } from "../../types/agent.ts";
import type { RollConfig } from "../../config/schema.ts";

export default defineCommand({
  meta: { description: "直接调用已注册 Agent 的指定 MCP tool" },
  args: {
    agent: { type: "positional", description: "Agent 名称", required: false },
    tool: { type: "positional", description: "MCP tool 名称", required: false },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    verbose: { type: "boolean", alias: "v", description: "输出调试日志", default: false },
    bail: {
      type: "boolean",
      description: "batch 模式下遇到第一条失败即停止",
      default: false,
    },
    "input-json": {
      type: "string",
      description: "以 JSON 字符串提供完整 tool 输入对象；不能与 --input-file 同用",
    },
    "input-file": {
      type: "string",
      description: "从 JSON 文件读取完整 tool 输入对象；不能与 --input-json 同用",
    },
    "batch-json": {
      type: "string",
      description: "以 JSON array 提供多条调用；每项包含 agent/tool/input",
    },
    "batch-file": {
      type: "string",
      description: "从 JSON 文件读取 batch array；不能与 --batch-json 同用",
    },
    "batch-stdin": {
      type: "boolean",
      description: "从 stdin 读取 batch array；不能与 --batch-json 或 --batch-file 同用",
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);
    const connectionScope = new ManagedAgentConnectionScope(config.agents.dataDir, "run");
    const agentConnections = new Map<string, ConnectedAgent>();

    try {
      const samplingCall = createSamplingLLMCall(config);
      const sharedRunOptions = {
        store,
        config,
        connectionScope,
        agentConnections,
        ...(samplingCall ? { samplingCall } : {}),
      };
      if (hasBatchInput(rawArgs) && getLeadingPositionalCount(rawArgs) > 0) {
        log.error("batch 模式不接受 agent/tool 位置参数；请在每个 batch item 中声明 agent 和 tool");
        process.exitCode = 1;
        return;
      }

      const batchItems = parseBatchInput(rawArgs, { readStdin: readBatchStdinFromProcess });
      if (batchItems) {
        const results = await runBatchToolCalls({
          items: batchItems,
          ...sharedRunOptions,
          bail: args.bail === true,
        });

        if (args.json) {
          console.log(JSON.stringify(results.map(formatRunToolResultForJsonOutput), null, 2));
        } else {
          printBatchResults(results);
        }

        if (results.some((result) => !result.ok)) {
          process.exitCode = 1;
        }
        return;
      }

      const agentName = parseRequiredStringArgument(args.agent, "agent");
      const toolName = parseRequiredStringArgument(args.tool, "tool");
      if (!agentName || !toolName) {
        log.error(
          "roll run 需要提供 agent/tool 位置参数，或使用 --batch-json / --batch-file / --batch-stdin 进入 batch 模式",
        );
        process.exitCode = 1;
        return;
      }

      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = resolveToolArgs(rawArgs);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      const outcome = await runToolCall({
        item: { agent: agentName, tool: toolName, input: toolArgs },
        index: 0,
        ...sharedRunOptions,
      });

      if (outcome.ok) {
        if (args.json) {
          console.log(JSON.stringify(formatToolResultForJsonOutput(outcome.result), null, 2));
        } else {
          printToolResultText(outcome.result);
        }
        log.success("调用完成");
      } else {
        if (args.json) {
          console.log(JSON.stringify(formatRunToolResultForJsonOutput(outcome), null, 2));
        } else {
          log.error(outcome.error);
          if (outcome.result !== undefined) {
            printToolResultText(outcome.result);
          }
        }
        process.exitCode = 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause ? `\n  cause: ${String(err.cause)}` : "";
      log.error(`${message}${cause}`);
      process.exitCode = 1;
    } finally {
      await connectionScope.disconnectAll();
    }
  },
});

/** run 命令的 CLI 保留参数（不应透传给 tool） */
const CLI_FLAG_OPTIONS = new Set(["json", "verbose", "v", "bail", "help", "h", "version"]);
const CLI_BOOLEAN_OPTIONS = new Set(["batch-stdin"]);
const CLI_VALUE_OPTIONS = new Set([
  "config",
  "input-json",
  "input-file",
  "batch-json",
  "batch-file",
]);

export interface RunBatchItem {
  readonly agent: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly label?: string;
}

interface ConnectedAgent {
  readonly agent: RegisteredAgent;
  readonly client: Client;
  readonly tools: readonly AgentTool[];
  readonly envReport: AgentEnvCheckReport | undefined;
}

interface RunToolCallOptions {
  readonly item: RunBatchItem;
  readonly index: number;
  readonly store: AgentStore;
  readonly config: RollConfig;
  readonly connectionScope: ManagedAgentConnectionScope;
  readonly agentConnections: Map<string, ConnectedAgent>;
  readonly samplingCall?: ResolvedLLMCall;
}

interface RunBatchToolCallsOptions extends Omit<RunToolCallOptions, "item" | "index"> {
  readonly items: readonly RunBatchItem[];
  readonly bail: boolean;
}

interface RunToolBaseResult {
  readonly index: number;
  readonly agent: string;
  readonly tool: string;
  readonly label?: string;
}

export interface RunToolSuccessResult extends RunToolBaseResult {
  readonly ok: true;
  readonly result: unknown;
}

export interface RunToolFailureResult extends RunToolBaseResult {
  readonly ok: false;
  readonly error: string;
  readonly result?: unknown;
}

export type RunToolResult = RunToolSuccessResult | RunToolFailureResult;

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

function parseJsonArrayInput(source: string, context: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(
      `${context} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${context} 必须是 JSON array`);
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

function getCliBooleanOption(rawArgs: string[], optionName: string): boolean {
  let i = 0;
  while (i < rawArgs.length && !rawArgs[i]?.startsWith("--")) {
    i++;
  }

  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === `--${optionName}`) {
      return true;
    }

    i++;
  }

  return false;
}

function hasBatchInput(rawArgs: string[]): boolean {
  return (
    hasCliOption(rawArgs, "batch-json") ||
    hasCliOption(rawArgs, "batch-file") ||
    hasCliOption(rawArgs, "batch-stdin")
  );
}

function hasCliOption(rawArgs: string[], optionName: string): boolean {
  let i = 0;
  while (i < rawArgs.length && !rawArgs[i]?.startsWith("--")) {
    i++;
  }

  while (i < rawArgs.length) {
    if (rawArgs[i] === `--${optionName}`) {
      return true;
    }
    i++;
  }

  return false;
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

interface ParseBatchInputOptions {
  readonly readStdin?: () => string;
}

export function parseBatchInput(
  rawArgs: string[],
  options: ParseBatchInputOptions = {},
): readonly RunBatchItem[] | undefined {
  const batchJson = getCliValueOption(rawArgs, "batch-json");
  const batchFile = getCliValueOption(rawArgs, "batch-file");
  const batchStdin = getCliBooleanOption(rawArgs, "batch-stdin");
  const inputJson = getCliValueOption(rawArgs, "input-json");
  const inputFile = getCliValueOption(rawArgs, "input-file");

  const explicitInputCount = [
    batchJson,
    batchFile,
    batchStdin ? "--batch-stdin" : undefined,
  ].filter((value) => value !== undefined).length;
  if (explicitInputCount > 1) {
    throw new Error("不能同时使用 --batch-json、--batch-file 和 --batch-stdin");
  }

  if (!batchJson && !batchFile && !batchStdin) {
    return undefined;
  }

  if (inputJson || inputFile) {
    throw new Error("batch 模式不能同时使用 --input-json 或 --input-file");
  }

  const batchSource =
    batchJson ?? (batchFile ? readFileSync(batchFile, "utf-8") : readBatchFromStdin(options));
  const context = batchJson
    ? "--batch-json"
    : batchFile
      ? `batch 文件 ${batchFile}`
      : "--batch-stdin";
  const parsed = parseJsonArrayInput(batchSource, context);
  if (parsed.length === 0) {
    throw new Error(`${context} 至少需要包含一条调用`);
  }

  return parsed.map((item, index) => normalizeBatchItem(item, index));
}

function readBatchFromStdin(options: ParseBatchInputOptions): string {
  if (!options.readStdin) {
    throw new Error("--batch-stdin 需要可用的 stdin 读取器");
  }

  return options.readStdin();
}

function readBatchStdinFromProcess(): string {
  if (process.stdin.isTTY) {
    throw new Error("--batch-stdin 需要从 stdin 管道或文件重定向读取 JSON array");
  }

  return readFileSync(0, "utf-8");
}

function normalizeBatchItem(value: unknown, index: number): RunBatchItem {
  const context = `batch[${String(index)}]`;
  if (!isRecordObject(value)) {
    throw new Error(`${context} 必须是 JSON object`);
  }

  const agent = value.agent;
  const tool = value.tool;
  const input = "input" in value ? value.input : {};
  const label = value.label;

  if (typeof agent !== "string" || agent.trim().length === 0) {
    throw new Error(`${context}.agent 必须是非空字符串`);
  }

  if (typeof tool !== "string" || tool.trim().length === 0) {
    throw new Error(`${context}.tool 必须是非空字符串`);
  }

  if (input !== undefined && !isRecordObject(input)) {
    throw new Error(`${context}.input 必须是 JSON object`);
  }

  if (label !== undefined && typeof label !== "string") {
    throw new Error(`${context}.label 必须是字符串`);
  }

  return {
    agent,
    tool,
    input: input ?? {},
    ...(label !== undefined ? { label } : {}),
  };
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

function getLeadingPositionalCount(rawArgs: readonly string[]): number {
  let count = 0;
  for (const arg of rawArgs) {
    if (arg.startsWith("--")) {
      return count;
    }
    count += 1;
  }

  return count;
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
    if (CLI_FLAG_OPTIONS.has(key) || CLI_BOOLEAN_OPTIONS.has(key)) {
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

function parseRequiredStringArgument(value: unknown, name: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    log.error(`缺少必填位置参数：${name}`);
    return undefined;
  }

  return value;
}

function createSamplingLLMCall(config: RollConfig): ResolvedLLMCall | undefined {
  const providerName = config.llm.defaultProvider;
  const providerConfig = config.llm.providers[providerName];
  return providerConfig
    ? resolveLLMCall(
        providerName,
        config.llm.defaultModel,
        providerConfig.apiKey,
        "sampling",
        providerConfig.baseUrl,
        config.runtime.thinkingLevel,
      )
    : undefined;
}

async function getConnectedAgent(options: RunToolCallOptions): Promise<ConnectedAgent | string> {
  const existing = options.agentConnections.get(options.item.agent);
  if (existing) {
    return existing;
  }

  const agent = options.store.findByName(options.item.agent);
  if (!agent) {
    return `Agent "${options.item.agent}" 未注册。使用 \`roll agent list\` 查看已注册 Agent。`;
  }

  log.info(`连接 Agent "${agent.skill.name}"...`);
  const agentEnv = getAgentEnv(options.config, agent.skill.name);
  const client = await options.connectionScope.connect(agent, {
    ...toSamplingConnectOptions(options.samplingCall),
    ...(agentEnv ? { env: agentEnv } : {}),
  });
  const tools = normalizeListedTools((await client.listTools()).tools, {
    onSchemaIssue: (issue) => log.warn(formatToolSchemaIssue(agent.skill.name, issue)),
  });
  const envReport = inspectAgentEnvRequirements(
    agent.skill.name,
    agent.skill.env,
    options.config.agents.env,
  );
  const connectedAgent = { agent, client, tools, envReport };
  options.agentConnections.set(options.item.agent, connectedAgent);
  return connectedAgent;
}

async function runToolCall(options: RunToolCallOptions): Promise<RunToolResult> {
  const base = createRunToolBaseResult(options.item, options.index);

  try {
    const connectedAgent = await getConnectedAgent(options);
    if (typeof connectedAgent === "string") {
      return { ...base, ok: false, error: connectedAgent };
    }

    const targetTool = connectedAgent.tools.find((tool) => tool.name === options.item.tool);
    if (!targetTool) {
      return {
        ...base,
        ok: false,
        error: formatMissingToolMessage(
          connectedAgent.agent.skill.name,
          options.item.tool,
          connectedAgent.tools,
        ),
      };
    }

    const runtimeIssues = shouldSkipRuntimeReadinessForTool(targetTool.name)
      ? []
      : getMissingAgentEnvRuntimeIssues(connectedAgent.envReport);
    const preflightResult = preflightToolCall(targetTool, options.item.input, {
      runtimeIssues,
    });
    if (!preflightResult.ok) {
      return {
        ...base,
        ok: false,
        error: formatValidationIssuesMessage(
          connectedAgent.agent.skill.name,
          options.item.tool,
          preflightResult.issues,
          preflightResult.runtimeIssues,
        ),
      };
    }

    log.info(`调用 ${connectedAgent.agent.skill.name}.${options.item.tool}`);
    log.debug(`调用参数: ${JSON.stringify(redactToolArgsForLog(options.item.input))}`);
    const result = await connectedAgent.client.callTool({
      name: options.item.tool,
      arguments: options.item.input,
    });
    if (isToolErrorResult(result)) {
      return { ...base, ok: false, error: "tool 返回 isError=true", result };
    }

    return { ...base, ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? `\n  cause: ${String(err.cause)}` : "";
    return { ...base, ok: false, error: `${message}${cause}` };
  }
}

function createRunToolBaseResult(item: RunBatchItem, index: number): RunToolBaseResult {
  return {
    index,
    agent: item.agent,
    tool: item.tool,
    ...(item.label ? { label: item.label } : {}),
  };
}

async function runBatchToolCalls(options: RunBatchToolCallsOptions): Promise<RunToolResult[]> {
  const results: RunToolResult[] = [];

  for (const [index, item] of options.items.entries()) {
    const result = await runToolCall({ ...options, item, index });
    results.push(result);
    if (!result.ok && options.bail) {
      break;
    }
  }

  return results;
}

function printToolResultText(result: unknown): void {
  if (typeof result === "object" && result !== null && "content" in result) {
    for (const text of extractTextContent(result.content)) {
      console.log(text);
    }
    return;
  }

  if (typeof result === "string") {
    console.log(result);
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

export function formatRunToolResultForJsonOutput(result: RunToolResult): RunToolResult {
  if (result.ok) {
    return { ...result, result: formatToolResultForJsonOutput(result.result) };
  }

  if ("result" in result) {
    return { ...result, result: formatToolResultForJsonOutput(result.result) };
  }

  return result;
}

function printBatchResults(results: readonly RunToolResult[]): void {
  for (const result of results) {
    const header = result.label
      ? `[${String(result.index + 1)}] ${result.label} (${result.agent}.${result.tool})`
      : `[${String(result.index + 1)}] ${result.agent}.${result.tool}`;
    console.log(header);

    if (result.ok) {
      printToolResultText(result.result);
      continue;
    }

    console.log(result.error);
  }
}
