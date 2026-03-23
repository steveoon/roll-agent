/** LLM 路由选中的目标 */
export interface RouteSelection {
  readonly agentName: string;
  readonly toolName: string;
  /** 置信度，取值范围 0–1，低于 ask.confirmThreshold 时请求用户确认 */
  readonly confidence: Confidence;
}

/** 绑定了工具输入后的最终调用决策 */
export interface RouteDecision extends RouteSelection {
  readonly input: Readonly<Record<string, unknown>>;
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
