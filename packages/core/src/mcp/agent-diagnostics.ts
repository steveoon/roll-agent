import { getAgentEnv, getAgentEnvFromAgentsConfig } from "../config/helpers.ts";
import {
  AgentRuntimeEnvDiagnosticPayloadSchema,
  DIAGNOSTIC_TOOL_CANDIDATES,
  type AgentRuntimeEnvInspection,
} from "../config/runtime-env.ts";
import { getAgentPid } from "../registry/process-manager.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import type { RollConfig } from "../config/schema.ts";
import { ManagedAgentConnectionScope } from "./managed-agent-connection.ts";

export async function inspectAgentRuntimeEnv(
  agent: RegisteredAgent,
  options: {
    readonly config?: RollConfig;
    readonly agentsConfig?: RollConfig["agents"];
    readonly timeoutMs?: number;
  },
): Promise<AgentRuntimeEnvInspection> {
  const agentsConfig = options.config?.agents ?? options.agentsConfig;
  if (agentsConfig === undefined) {
    throw new Error("inspectAgentRuntimeEnv requires config or agentsConfig.");
  }

  if (agent.runtime.ownership === "core-managed") {
    const pid = getAgentPid(agentsConfig.dataDir, agent.skill.name);
    if (pid === undefined) {
      return {
        status: "unverified",
        reason: "agent-not-running",
        message: "agent 未运行（缺少活动 PID）",
      };
    }
  }

  const connectionScope = new ManagedAgentConnectionScope(agentsConfig.dataDir, "diagnostics");

  try {
    const agentEnv =
      options.config !== undefined
        ? getAgentEnv(options.config, agent.skill.name)
        : getAgentEnvFromAgentsConfig(agentsConfig, agent.skill.name);
    const client = await connectionScope.connect(agent, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(agentEnv ? { env: agentEnv } : {}),
    });

    const { tools } = await client.listTools();
    const diagnosticTool = DIAGNOSTIC_TOOL_CANDIDATES.find((candidate) =>
      tools.some((tool) => tool.name === candidate),
    );

    if (!diagnosticTool) {
      return {
        status: "unverified",
        reason: "diagnostic-tool-unavailable",
        message: "agent 未暴露 diagnostic_status / browser_status.effectiveEnvSources",
      };
    }

    const result = await client.callTool({
      name: diagnosticTool,
      arguments: {},
    });
    const payload = AgentRuntimeEnvDiagnosticPayloadSchema.parse(parseToolJsonPayload(result));

    return {
      status: "verified",
      toolName: diagnosticTool,
      payload,
    };
  } catch (error) {
    return {
      status: "unverified",
      reason: "connection-failed",
      message: `无法校验运行态: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await connectionScope.disconnectAll();
  }
}

function parseToolJsonPayload(result: unknown): unknown {
  const text = extractToolText(result, "诊断 tool 未返回 text content");

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `诊断 tool 返回了不可解析的 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function extractToolText(result: unknown, fallback: string): string {
  const contentList = extractContentList(result);

  for (const content of contentList) {
    if (
      typeof content === "object" &&
      content !== null &&
      "type" in content &&
      content.type === "text" &&
      "text" in content &&
      typeof content.text === "string"
    ) {
      return content.text;
    }
  }

  throw new Error(fallback);
}

function extractContentList(result: unknown): readonly unknown[] {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("诊断 tool 未返回 MCP content 数组");
  }

  const content = result["content"];
  if (!Array.isArray(content)) {
    throw new Error("诊断 tool 返回的 content 不是数组");
  }

  return content;
}
