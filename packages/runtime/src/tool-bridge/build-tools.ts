import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { preflightToolCall } from "@roll-agent/core/tool-runtime/preflight";
import type { AgentTool } from "@roll-agent/core/types/agent";
import type { ApprovalDecision } from "../approval/approval-gate.ts";
import type { ToolAnnotations, ToolPolicy } from "../types/policy.ts";
import { ToolRegistry } from "./naming.ts";
import { normalizeToolResult, type NormalizedToolResult } from "./normalize-result.ts";

export interface SourceTool {
  readonly tool: AgentTool;
  readonly annotations: ToolAnnotations | undefined;
}

export interface AgentToolSource {
  readonly agentName: string;
  readonly client: Client;
  readonly tools: readonly SourceTool[];
}

export interface ApprovalRequest {
  readonly agentName: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reason: string | undefined;
}

export interface ToolBridgeContext {
  readonly policy?: ToolPolicy;
  readonly requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface BuiltToolset {
  readonly tools: ToolSet;
  readonly registry: ToolRegistry;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function formatPreflightFailure(
  issues: ReadonlyArray<{ readonly path: string; readonly message: string }>,
): string {
  return `参数校验失败: ${issues.map((issue) => issue.message).join("; ")}`;
}

async function gateToolCall(
  ctx: ToolBridgeContext,
  agentName: string,
  toolName: string,
  input: Record<string, unknown>,
  annotations: ToolAnnotations | undefined,
): Promise<NormalizedToolResult | undefined> {
  if (!ctx.policy) {
    return undefined;
  }
  const decision = ctx.policy.check({
    agentName,
    toolName,
    input,
    ...(annotations ? { annotations } : {}),
  });
  if (decision.action === "deny") {
    return {
      output: `策略拒绝执行${decision.reason ? `: ${decision.reason}` : ""}`,
      isError: true,
    };
  }
  if (decision.action === "confirm") {
    const approval = await ctx.requestApproval({
      agentName,
      toolName,
      input,
      reason: decision.reason,
    });
    if (!approval.approved) {
      return {
        output: `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`,
        isError: true,
      };
    }
  }
  return undefined;
}

export function buildAgentToolset(
  sources: readonly AgentToolSource[],
  ctx: ToolBridgeContext,
): BuiltToolset {
  const registry = new ToolRegistry();
  const tools: ToolSet = {};

  for (const source of sources) {
    const { client, agentName } = source;
    for (const { tool: agentTool, annotations } of source.tools) {
      const id = registry.register(agentName, agentTool.name);
      tools[id] = tool({
        description: agentTool.description ?? `${agentTool.name} (via ${agentName})`,
        inputSchema: jsonSchema(agentTool.inputSchema as unknown as JSONSchema7),
        execute: async (
          input: unknown,
          options: ToolExecutionOptions<unknown>,
        ): Promise<NormalizedToolResult> => {
          const args = asRecord(input);
          const preflight = preflightToolCall(agentTool, args);
          if (!preflight.ok) {
            return { output: formatPreflightFailure(preflight.issues), isError: true };
          }
          const blocked = await gateToolCall(ctx, agentName, agentTool.name, args, annotations);
          if (blocked) {
            return blocked;
          }
          const requestOptions = options.abortSignal ? { signal: options.abortSignal } : undefined;
          const result = await client.callTool(
            { name: agentTool.name, arguments: args },
            undefined,
            requestOptions,
          );
          return normalizeToolResult(result);
        },
      });
    }
  }

  return { tools, registry };
}
