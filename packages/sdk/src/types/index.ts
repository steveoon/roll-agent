import type { z } from "zod";
import type { AgentContext } from "../context.ts";

/** 类型擦除的 Tool 基础接口，用于异构集合 */
export interface AnyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
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
  readonly listen?: () => void;
}
