import type { z } from "zod";
import type { ToolAnnotations as McpToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AgentContext } from "../context.ts";

export const TOOL_RESOURCE_ACCESS_MODES = {
  read: "read",
  write: "write",
} as const;

export type ToolResourceAccessMode =
  (typeof TOOL_RESOURCE_ACCESS_MODES)[keyof typeof TOOL_RESOURCE_ACCESS_MODES];

export const TOOL_RESOURCE_HINT_KINDS = {
  file: "file",
  browserSession: "browser-session",
  conversation: "conversation",
  custom: "custom",
} as const;

export type ToolResourceHintKind =
  (typeof TOOL_RESOURCE_HINT_KINDS)[keyof typeof TOOL_RESOURCE_HINT_KINDS];

export interface ToolResourceHint {
  /** Top-level input field containing one resource id or an array of ids. */
  readonly field: string;
  readonly kind: ToolResourceHintKind;
  readonly mode?: ToolResourceAccessMode;
  /** Required for `custom`; ignored for built-in kinds. */
  readonly namespace?: string;
}

/** 类型擦除的 Tool 基础接口，用于异构集合 */
export interface AnyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly annotations?: McpToolAnnotations;
  readonly resourceHints?: readonly ToolResourceHint[];
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly execute: (input: never, ctx: AgentContext) => Promise<unknown>;
}

/** 类型安全的 Tool 定义 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> extends AnyToolDefinition {
  readonly input: z.ZodType<TInput>;
  readonly output: z.ZodType<TOutput>;
  readonly execute: (input: TInput, ctx: AgentContext) => Promise<TOutput>;
}

export interface AgentDefinition {
  readonly name: string;
  readonly tools: ReadonlyArray<AnyToolDefinition>;
}

// ========== Transport 配置 ==========

export type TransportConfig =
  | { readonly type: "stdio" }
  | { readonly type: "http"; readonly port: number; readonly host?: string };

export interface ListenOptions {
  readonly transport?: TransportConfig;
}

/** defineAgent() 返回的可运行 Agent */
export interface RunnableAgent extends AgentDefinition {
  /** 启动 MCP Server，阻塞直到连接关闭 */
  readonly listen: (options?: ListenOptions) => Promise<void>;
}
