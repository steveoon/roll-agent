import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { RegisteredAgent } from "../types/agent.ts";
import type { RouteSelection } from "../types/router.ts";
import { asConfidence } from "../types/router.ts";

/** LLM 路由决策的 Zod schema */
const routeSelectionSchema = z.object({
  agentName: z.string().describe("选择的 Agent 名称"),
  toolName: z.string().describe("选择的 Tool 名称"),
  confidence: z.number().describe("决策置信度 0-1"),
});

/** 构建 Agent 能力描述，供 LLM 理解 */
function buildAgentCatalog(agents: ReadonlyArray<RegisteredAgent>): string {
  if (agents.length === 0) {
    return "当前没有已注册的 Agent。";
  }

  return agents
    .map((agent) => {
      const name = agent.skill.name;
      const desc = agent.skill.description;
      const toolsSection = agent.skillBody ? `\n  能力详情:\n${agent.skillBody}` : "";
      return `Agent: ${name}\n  描述: ${desc}\n  状态: ${agent.status}${toolsSection}`;
    })
    .join("\n\n");
}

/** 从 LLM 纯文本响应中解析路由 JSON */
function parseRouteJson(text: string): { agentName: string; toolName: string; confidence: number } {
  const trimmed = text.trim();

  // 尝试直接解析，或提取 ```json 代码块，或提取首个 { ... }
  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const result = routeSelectionSchema.parse(JSON.parse(candidate));
      return result;
    } catch {}
  }

  throw new Error("LLM router: text fallback did not produce valid route JSON");
}

function buildRouteTextFallbackPrompt(message: string): string {
  return [
    message,
    "",
    "只输出一个 JSON object。",
    "字段必须是 agentName(string)、toolName(string)、confidence(number 0-1)。",
    "不要输出 Markdown 代码块。",
    "不要解释，不要补充额外文本。",
  ].join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 使用 LLM 从用户自然语言意图中选择最合适的 Agent + Tool。
 *
 * 两步走：
 * 1. 优先尝试 structured output
 * 2. 仅当模型未遵循 schema 时，降级为纯文本 JSON fallback
 */
export async function routeWithLLM(
  message: string,
  agents: ReadonlyArray<RegisteredAgent>,
  model: LanguageModelV4,
  structuredOutputProviderOptions?: SharedV4ProviderOptions,
): Promise<RouteSelection> {
  const catalog = buildAgentCatalog(agents);

  const systemPrompt = `你是 Roll Agent 的智能路由器。根据用户的自然语言请求，从已注册的 Agent 中选择最合适的 Agent 和 Tool。以 JSON 格式返回结果。

已注册的 Agent 列表：
${catalog}

规则：
- 选择与用户意图最匹配的 Agent 和 Tool
- 这一阶段只负责选择 Agent 和 Tool，不要推测或生成 Tool 参数
- confidence 字段表示你对这个匹配的把握程度（0-1）
- 如果没有合适的 Agent 匹配，confidence 应该很低（< 0.3）`;

  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: routeSelectionSchema }),
      system: systemPrompt,
      prompt: message,
      ...(structuredOutputProviderOptions
        ? { providerOptions: structuredOutputProviderOptions }
        : {}),
    });

    if (!output) {
      throw new Error("structured output returned null");
    }

    return {
      agentName: output.agentName,
      toolName: output.toolName,
      confidence: asConfidence(Math.min(1, Math.max(0, output.confidence))),
    };
  } catch (structuredOutputError) {
    if (!NoObjectGeneratedError.isInstance(structuredOutputError)) {
      throw structuredOutputError;
    }

    try {
      // 降级：部分模型不严格遵循 json_schema，尝试纯文本 + JSON.parse
      const textResult = await generateText({
        model,
        system: systemPrompt,
        prompt: buildRouteTextFallbackPrompt(message),
      });

      const parsed = parseRouteJson(textResult.text);
      return {
        agentName: parsed.agentName,
        toolName: parsed.toolName,
        confidence: asConfidence(Math.min(1, Math.max(0, parsed.confidence))),
      };
    } catch (textFallbackError) {
      throw new Error(
        "LLM router: failed to produce route selection" +
          ` (structured output: ${getErrorMessage(structuredOutputError)};` +
          ` text fallback: ${getErrorMessage(textFallbackError)})`,
        { cause: textFallbackError },
      );
    }
  }
}
