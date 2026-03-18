import { generateText, jsonSchema, Output } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { AgentTool } from "../types/agent.ts";
import { createExtractionSchema, normalizeExtractedToolInput } from "./extraction-schema.ts";

function buildToolInputPrompt(
  message: string,
  tool: Pick<AgentTool, "name" | "description" | "inputSchema">,
): string {
  return [
    "你要为一个工具调用提取参数。",
    "只使用工具 schema 中已有的字段名，不要发明新字段。",
    "如果用户没有提供某个值，不要猜测，也不要填充默认值。",
    "输出必须是一个 JSON object，且严格符合 schema。",
    "",
    `[Tool] ${tool.name}`,
    tool.description ? `[Description] ${tool.description}` : "",
    "[Input Schema]",
    JSON.stringify(tool.inputSchema, null, 2),
    "",
    "[User Message]",
    message,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function extractToolInput(
  message: string,
  tool: Pick<AgentTool, "name" | "description" | "inputSchema">,
  model: LanguageModelV3,
): Promise<Readonly<Record<string, unknown>>> {
  const { output } = await generateText({
    model,
    output: Output.object({
      schema: jsonSchema<Readonly<Record<string, unknown>>>(
        createExtractionSchema(tool.inputSchema),
      ),
    }),
    prompt: buildToolInputPrompt(message, tool),
  });

  if (!output) {
    throw new Error(`Failed to extract arguments for tool "${tool.name}"`);
  }

  return normalizeExtractedToolInput(tool.inputSchema, output);
}
