export type RouterMode = "declarative" | "llm" | "auto";

/** LLM 路由决策结果 */
export interface RouteDecision {
  readonly agentName: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly confidence: number;
}
