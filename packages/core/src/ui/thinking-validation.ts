import { getChatGptAuthService, type ChatGptAuthService } from "../auth/chatgpt/service.ts";
import type { RollConfig } from "../config/schema.ts";
import { chatGptThinkingLevels, legacyThinkingLevels } from "../llm/thinking-levels.ts";

/** UI validation uses available capability data; inference still validates against live models. */
export function validateUiThinkingConfig(
  config: RollConfig,
  getModels: ChatGptAuthService["cachedModels"] = (accountId) =>
    getChatGptAuthService().cachedModels(accountId),
): void {
  const provider = config.runtime.provider ?? config.llm.defaultProvider;
  const model =
    provider === "chatgpt"
      ? getModels(config.runtime.chatgptAccountId).find(({ slug }) => slug === config.runtime.model)
      : undefined;
  // Missing model/effort data is unknown, not evidence that only the legacy four levels exist.
  if (provider === "chatgpt" && model?.reasoningEfforts === undefined) return;
  const options = provider === "chatgpt" ? chatGptThinkingLevels(model) : legacyThinkingLevels;
  const levels = [
    ["runtime.thinkingLevel", config.runtime.thinkingLevel],
    [
      "runtime.compaction.thinkingLevel",
      config.runtime.compaction.thinkingLevel ?? config.runtime.thinkingLevel,
    ],
  ] as const;
  const issues = levels
    .filter(([, level]) => !options.some((option) => option === level))
    .map(
      ([path, level]) =>
        `  - ${path}: 当前模型不支持推理强度 "${level}"；可选档位：${options.join(" / ") || "无"}。`,
    );
  if (issues.length > 0) throw new Error(`Config validation failed:\n${issues.join("\n")}`);
}
