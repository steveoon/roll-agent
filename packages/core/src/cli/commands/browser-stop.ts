import { defineCommand } from "citty";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { getAgentEnv } from "../../config/helpers.ts";
import { loadConfig } from "../../config/loader.ts";
import { McpClientManager } from "../../mcp/client-manager.ts";
import { getAgentPid } from "../../registry/process-manager.ts";
import { resolveTransportWithDevSpawnSpec } from "../../registry/dev-spawn.ts";
import { AgentStore } from "../../registry/store.ts";
import type { RegisteredAgent } from "../../types/agent.ts";
import { formatMissingToolMessage, normalizeListedTools } from "../utils/agent-tools.ts";
import {
  extractTextContent,
  formatToolResultForJsonOutput,
  isToolErrorResult,
} from "../utils/tool-results.ts";
import { log } from "../utils/output.ts";
import type { BrowserConfig } from "../../config/schema.ts";

const BROWSER_USE_AGENT_NAME = "browser-use-agent";
const BROWSER_STOP_TOOL_NAME = "browser_stop";
const BROWSER_STOP_VALUE_OPTIONS = new Set(["config"]);

export const BROWSER_STOP_COMMAND_DESCRIPTION =
  "关闭 browser-use-agent 当前托管的浏览器实例；不会停止 browser-use-agent 服务进程。";
export const BROWSER_STOP_INSTANCE_DESCRIPTION =
  "一个或多个 browserInstance；不传时必须显式使用 --all。";
export const BROWSER_STOP_ALL_DESCRIPTION =
  "关闭所有已启动的浏览器实例，但保留 browser-use-agent 进程继续运行；不同于 roll agent stop browser-use-agent。";
export const BROWSER_USE_AGENT_NOT_RUNNING_MESSAGE =
  "browser-use-agent 未运行；没有由当前 agent 托管的浏览器实例可关闭。不会扫描或查杀系统 Chrome 进程。";

const BrowserStopStatusSchema = z.enum(["stopped", "not_running", "not_found", "failed"]);

const BrowserStopResultSchema = z.object({
  browserInstance: z.string(),
  status: BrowserStopStatusSchema,
  mode: z.enum(["managed-cdp", "remote-cdp", "existing-session"]).optional(),
  message: z.string().optional(),
});

const BrowserStopToolResultSchema = z.object({
  ok: z.boolean(),
  stopped: z.number().int().nonnegative(),
  results: z.array(BrowserStopResultSchema),
});

type BrowserStopToolResult = z.infer<typeof BrowserStopToolResultSchema>;
type BrowserStopResult = z.infer<typeof BrowserStopResultSchema>;

export interface BrowserStopRequest {
  readonly all: boolean;
  readonly instances: readonly string[];
  readonly toolInput: Readonly<Record<string, unknown>>;
}

export interface BrowserStopJsonOutput extends BrowserStopToolResult {
  readonly agentRunning: boolean;
  readonly message?: string;
}

export default defineCommand({
  meta: {
    description: BROWSER_STOP_COMMAND_DESCRIPTION,
  },
  args: {
    instance: {
      type: "positional",
      description: BROWSER_STOP_INSTANCE_DESCRIPTION,
      required: false,
    },
    all: {
      type: "boolean",
      description: BROWSER_STOP_ALL_DESCRIPTION,
      default: false,
    },
    json: {
      type: "boolean",
      description: "JSON 格式输出",
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    const jsonOutput = args.json === true;
    const clientManager = new McpClientManager();

    try {
      const request = resolveBrowserStopRequest({
        rawArgs,
        all: args.all === true,
      });
      const { config } = loadConfig();
      validateDeclaredBrowserStopInstances(config.browser, request);
      const store = new AgentStore(config.agents.dataDir);
      const agent = store.findByName(BROWSER_USE_AGENT_NAME);
      if (agent === undefined) {
        throw new Error(
          `Agent "${BROWSER_USE_AGENT_NAME}" 未注册。使用 \`roll agent list\` 查看已注册 Agent。`,
        );
      }

      const agentNotRunning = shouldTreatAgentAsNotRunning(agent, config.agents.dataDir);
      if (agentNotRunning) {
        const output = createBrowserStopAgentNotRunningOutput();
        printBrowserStopJsonOrText(output, request, jsonOutput);
        return;
      }
      if (agent.runtime.ownership === "on-demand") {
        throw new Error(
          `${BROWSER_USE_AGENT_NAME} 不是常驻服务，无法执行实例级 browser runtime stop。`,
        );
      }

      const agentEnv = getAgentEnv(config, agent.skill.name);
      const transport = resolveTransportWithDevSpawnSpec(agent);
      let client: Client;
      try {
        client = await clientManager.connect(agent.skill.name, transport, agent.installPath, {
          timeoutMs: 5_000,
          ...(agentEnv ? { env: agentEnv } : {}),
        });
      } catch (error) {
        if (agent.runtime.ownership === "external-managed") {
          const output = createBrowserStopAgentNotRunningOutput();
          printBrowserStopJsonOrText(output, request, jsonOutput);
          return;
        }

        throw new Error(`${BROWSER_USE_AGENT_NAME} 正在运行但无法连接。`, { cause: error });
      }

      const listedTools = normalizeListedTools((await client.listTools()).tools);
      const stopTool = listedTools.find((tool) => tool.name === BROWSER_STOP_TOOL_NAME);
      if (stopTool === undefined) {
        throw new Error(
          formatMissingToolMessage(agent.skill.name, BROWSER_STOP_TOOL_NAME, listedTools),
        );
      }

      const toolResult = await client.callTool({
        name: BROWSER_STOP_TOOL_NAME,
        arguments: request.toolInput,
      });
      if (isToolErrorResult(toolResult)) {
        throw new Error(
          extractTextContent(toolResult.content).join("\n") || "browser_stop 返回 isError=true",
        );
      }
      const result = parseBrowserStopToolResult(toolResult);

      const output: BrowserStopJsonOutput = {
        ...result,
        agentRunning: true,
      };
      printBrowserStopJsonOrText(output, request, jsonOutput);
      if (hasBrowserStopFailures(result.results)) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (jsonOutput) {
        console.log(JSON.stringify({ ok: false, message }, null, 2));
      } else {
        log.error(message);
      }
      process.exitCode = 1;
    } finally {
      await clientManager.disconnectAll();
    }
  },
});

export function resolveBrowserStopRequest(input: {
  readonly rawArgs: readonly string[];
  readonly all: boolean;
}): BrowserStopRequest {
  const instances = parseBrowserStopInstances(input.rawArgs);
  if (input.all && instances.length > 0) {
    throw new Error("--all 不能和 browserInstance 位置参数同时使用。");
  }

  if (!input.all && instances.length === 0) {
    throw new Error("请提供一个或多个 browserInstance，或显式使用 --all。");
  }

  if (input.all) {
    return {
      all: true,
      instances: [],
      toolInput: { all: true },
    };
  }

  return {
    all: false,
    instances,
    toolInput:
      instances.length === 1 ? { browserInstance: instances[0] } : { browserInstances: instances },
  };
}

export function parseBrowserStopInstances(rawArgs: readonly string[]): readonly string[] {
  const instances: string[] = [];
  let index = 0;

  while (index < rawArgs.length) {
    const arg = rawArgs[index];
    if (arg === undefined) {
      index += 1;
      continue;
    }

    if (arg === "--") {
      instances.push(
        ...rawArgs
          .slice(index + 1)
          .map((value) => value.trim())
          .filter(Boolean),
      );
      break;
    }

    if (arg.startsWith("--")) {
      const optionName = arg.slice(2).split("=", 1)[0] ?? "";
      index += BROWSER_STOP_VALUE_OPTIONS.has(optionName) && !arg.includes("=") ? 2 : 1;
      continue;
    }

    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }

    const trimmed = arg.trim();
    if (trimmed.length > 0) {
      instances.push(trimmed);
    }
    index += 1;
  }

  return [...new Set(instances)];
}

export function parseBrowserStopToolResult(result: unknown): BrowserStopToolResult {
  return BrowserStopToolResultSchema.parse(formatToolResultForJsonOutput(result));
}

export function validateDeclaredBrowserStopInstances(
  browserConfig: BrowserConfig,
  request: BrowserStopRequest,
): void {
  if (request.all || request.instances.length === 0) {
    return;
  }

  const declaredInstances = Object.keys(browserConfig.instances);
  if (declaredInstances.length === 0) {
    return;
  }

  const missingInstances = request.instances.filter(
    (instance) => browserConfig.instances[instance] === undefined,
  );
  if (missingInstances.length === 0) {
    return;
  }

  throw new Error(
    `browserInstance ${missingInstances.map((instance) => `"${instance}"`).join(", ")} 未声明` +
      `；可用实例: ${declaredInstances.join(", ")}`,
  );
}

export function createBrowserStopAgentNotRunningOutput(): BrowserStopJsonOutput {
  return {
    ok: true,
    agentRunning: false,
    stopped: 0,
    results: [],
    message: BROWSER_USE_AGENT_NOT_RUNNING_MESSAGE,
  };
}

export function createBrowserStopTextLines(
  output: BrowserStopJsonOutput,
  request: BrowserStopRequest,
): readonly string[] {
  if (!output.agentRunning) {
    return [output.message ?? BROWSER_USE_AGENT_NOT_RUNNING_MESSAGE];
  }

  const lines: string[] = [];
  if (request.all) {
    lines.push(
      output.stopped > 0
        ? "已关闭所有已启动 browser instances；browser-use-agent 仍在运行。"
        : "没有已启动 browser instances 需要关闭；browser-use-agent 仍在运行。",
    );
  } else if (request.instances.length === 1 && output.results[0]?.status === "stopped") {
    lines.push(`已关闭 browser instance "${request.instances[0]}"；browser-use-agent 仍在运行。`);
  } else {
    lines.push(
      `已处理 ${String(output.results.length)} 个 browser instances；` +
        `已关闭 ${String(output.stopped)} 个；browser-use-agent 仍在运行。`,
    );
  }

  for (const result of output.results) {
    if (result.status === "stopped") {
      continue;
    }
    lines.push(formatBrowserStopResultLine(result));
  }

  return lines;
}

function printBrowserStopJsonOrText(
  output: BrowserStopJsonOutput,
  request: BrowserStopRequest,
  jsonOutput: boolean,
): void {
  if (jsonOutput) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const lines = createBrowserStopTextLines(output, request);
  for (const line of lines) {
    if (output.ok) {
      log.success(line);
    } else {
      log.error(line);
    }
  }
}

function formatBrowserStopResultLine(result: BrowserStopResult): string {
  const suffix = result.message !== undefined ? `：${result.message}` : "";
  switch (result.status) {
    case "not_running":
      return `browser instance "${result.browserInstance}" 当前未运行。`;
    case "not_found":
      return `browser instance "${result.browserInstance}" 不存在${suffix}`;
    case "failed":
      return `browser instance "${result.browserInstance}" 关闭失败${suffix}`;
    case "stopped":
      return `已关闭 browser instance "${result.browserInstance}"。`;
  }
}

function hasBrowserStopFailures(results: readonly BrowserStopResult[]): boolean {
  return results.some((result) => result.status === "not_found" || result.status === "failed");
}

function shouldTreatAgentAsNotRunning(agent: RegisteredAgent, dataDir: string): boolean {
  if (agent.runtime.ownership !== "core-managed") {
    return false;
  }

  return getAgentPid(dataDir, agent.skill.name) === undefined;
}
