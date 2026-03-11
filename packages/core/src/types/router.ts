import type { RollConfig } from "../config/schema.ts";

/** 路由模式 — 从 Zod schema 派生，保持单一数据源 */
export type RouterMode = RollConfig["router"]["mode"];

/** LLM 路由决策结果 */
export interface RouteDecision {
  readonly agentName: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** 置信度，取值范围 0–1，低于 confirmThreshold 时请求用户确认 */
  readonly confidence: Confidence;
}

/**
 * 0–1 范围的置信度品牌类型。
 * 使用 `asConfidence()` 构造以确保运行时校验。
 */
export type Confidence = number & { readonly __brand: "Confidence" };

/** 将 number 安全转换为 Confidence（运行时校验 0–1 范围） */
export function asConfidence(value: number): Confidence {
  if (value < 0 || value > 1) {
    throw new RangeError(`Confidence must be between 0 and 1, got ${String(value)}`);
  }
  return value as Confidence;
}
