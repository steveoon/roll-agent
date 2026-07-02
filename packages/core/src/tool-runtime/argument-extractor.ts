import { generateText, jsonSchema, Output } from "ai";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { AgentTool } from "../types/agent.ts";
import { isPlainObject } from "./schema.ts";
import { createExtractionSchema, normalizeExtractedToolInput } from "./extraction-schema.ts";

function buildToolInputPrompt(
  message: string,
  tool: Pick<AgentTool, "name" | "description" | "inputSchema">,
  extractionSchema: object,
): string {
  return [
    "你要为一个工具调用提取参数。以 JSON 格式返回结果。",
    "这里只提取能从当前消息中明确得到的字段，不要发明新字段。",
    "如果用户没有提供某个值，不要猜测，也不要填充默认值。",
    "如果用户明确提到了某个名字、品牌、城市、数字或其他实体，并且 schema 中有最匹配的字段，即使该字段是可选的，也应当提取出来。",
    "只有在用户消息里确实没有出现对应值时，才省略该可选字段。",
    "可选字段用省略表达，不要输出 null。",
    "系统会在后续按原始 tool 契约继续校验；这里只输出可提取参数的 JSON object。",
    "",
    `[Tool] ${tool.name}`,
    tool.description ? `[Description] ${tool.description}` : "",
    "[Extraction Schema]",
    JSON.stringify(extractionSchema, null, 2),
    "",
    "[User Message]",
    message,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildTextFallbackPrompt(
  message: string,
  tool: Pick<AgentTool, "name" | "description" | "inputSchema">,
  extractionSchema: object,
): string {
  return [
    buildToolInputPrompt(message, tool, extractionSchema),
    "",
    "只输出一个 JSON object。",
    "不要输出 Markdown 代码块。",
    "不要解释，不要补充额外文本。",
  ].join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getJsonTextCandidates(text: string): ReadonlyArray<string> {
  const trimmed = text.trim();
  const candidates = new Set<string>();

  if (trimmed) {
    candidates.add(trimmed);
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fencedJson = fenceMatch?.[1]?.trim();
  if (fencedJson) {
    candidates.add(fencedJson);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  return [...candidates];
}

function parseJsonObjectFromText(text: string): Readonly<Record<string, unknown>> {
  for (const candidate of getJsonTextCandidates(text)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {}
  }

  throw new Error("Text fallback did not produce a valid JSON object");
}

export async function extractToolInput(
  message: string,
  tool: Pick<AgentTool, "name" | "description" | "inputSchema">,
  model: LanguageModelV4,
  structuredOutputProviderOptions?: SharedV4ProviderOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const extractionSchema = createExtractionSchema(tool.inputSchema);

  try {
    const { output } = await generateText({
      model,
      output: Output.object({
        schema: jsonSchema<Readonly<Record<string, unknown>>>(extractionSchema),
      }),
      prompt: buildToolInputPrompt(message, tool, extractionSchema),
      ...(structuredOutputProviderOptions
        ? { providerOptions: structuredOutputProviderOptions }
        : {}),
    });

    if (!output) {
      throw new Error(`Failed to extract arguments for tool "${tool.name}"`);
    }

    return normalizeExtractedToolInput(tool.inputSchema, output);
  } catch (structuredOutputError) {
    try {
      const result = await generateText({
        model,
        prompt: buildTextFallbackPrompt(message, tool, extractionSchema),
      });

      return normalizeExtractedToolInput(tool.inputSchema, parseJsonObjectFromText(result.text));
    } catch (textFallbackError) {
      throw new Error(
        `Failed to extract arguments for tool "${tool.name}"` +
          ` (structured output: ${getErrorMessage(structuredOutputError)};` +
          ` text fallback: ${getErrorMessage(textFallbackError)})`,
        { cause: textFallbackError },
      );
    }
  }
}
