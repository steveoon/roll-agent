/** Browser-safe vocabulary; provider capabilities are separate from configuration syntax. */
export const legacyThinkingLevels = ["off", "low", "medium", "high"] as const;
export const runtimeThinkingLevels = [...legacyThinkingLevels, "xhigh", "max"] as const;
export type LegacyThinkingLevel = (typeof legacyThinkingLevels)[number];
export type ThinkingLevel = (typeof runtimeThinkingLevels)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return runtimeThinkingLevels.some((level) => level === value);
}

export function requireLegacyThinkingLevel(
  level: ThinkingLevel,
  provider: string,
): LegacyThinkingLevel {
  if (level === "xhigh" || level === "max") {
    throw new Error(
      `API Provider "${provider}" 不支持推理强度 "${level}"；可选档位：${legacyThinkingLevels.join(", ")}。`,
    );
  }
  return level;
}

/** ask/run own an API model, not the subscription model selected for chat/scheduler. */
export function apiSamplingThinkingLevel(
  runtime: { readonly provider?: string | undefined; readonly thinkingLevel: ThinkingLevel },
  apiProvider: string,
  warn: (message: string) => void,
): LegacyThinkingLevel {
  if (
    runtime.provider === "chatgpt" &&
    (runtime.thinkingLevel === "xhigh" || runtime.thinkingLevel === "max")
  ) {
    warn(
      `ChatGPT 聊天强度 ${runtime.thinkingLevel} 不适用于独立 API Sampling；ask/run 的 ${apiProvider} 模型使用默认 medium，不切换模型或授权通道。`,
    );
    return "medium";
  }
  return requireLegacyThinkingLevel(runtime.thinkingLevel, apiProvider);
}

export function chatGptThinkingLevels(model?: {
  readonly reasoningEfforts?: readonly string[] | undefined;
}): readonly ThinkingLevel[] {
  const efforts = model?.reasoningEfforts;
  if (efforts === undefined) return legacyThinkingLevels;
  return runtimeThinkingLevels.filter((level) =>
    efforts.includes(level === "off" ? "none" : level),
  );
}
