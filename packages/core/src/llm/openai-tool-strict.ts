import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from "@ai-sdk/provider";

type LanguageModelTool = NonNullable<LanguageModelV4CallOptions["tools"]>[number];

/**
 * OpenAI Responses attempts strict schema normalization when `strict` is omitted.
 * Default omitted function `strict` to `false` so only opt-in strict tools use strict grammars.
 */
export function withDefaultFalseFunctionToolStrict(
  tool: LanguageModelV4FunctionTool,
): LanguageModelV4FunctionTool {
  return tool.strict === undefined ? { ...tool, strict: false } : tool;
}

export function applyOpenAiResponsesToolStrictDefaults(
  tools: LanguageModelV4CallOptions["tools"],
): LanguageModelV4CallOptions["tools"] {
  if (!tools?.some((tool) => tool.type === "function" && tool.strict === undefined)) {
    return tools;
  }
  return tools.map(
    (tool): LanguageModelTool =>
      tool.type === "function" ? withDefaultFalseFunctionToolStrict(tool) : tool,
  );
}
