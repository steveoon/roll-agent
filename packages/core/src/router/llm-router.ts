import { generateText, Output } from "ai";
import { z } from "zod";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { RegisteredAgent } from "../types/agent.ts";
import type { RouteDecision } from "../types/router.ts";
import { asConfidence } from "../types/router.ts";

/** LLM 路由决策的 Zod schema */
const routeDecisionSchema = z.object({
  agentName: z.string().describe("选择的 Agent 名称"),
  toolName: z.string().describe("选择的 Tool 名称"),
  input: z.record(z.string(), z.unknown()).describe("传递给 Tool 的参数"),
  confidence: z.number().min(0).max(1).describe("决策置信度 0-1"),
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

/**
 * 使用 LLM 从用户自然语言意图中选择最合适的 Agent + Tool。
 *
 * 两步走：
 * 1. 构建包含所有 Agent 描述的 system prompt
 * 2. 用 generateObject 让 LLM 返回结构化的路由决策
 */
export async function routeWithLLM(
  message: string,
  agents: ReadonlyArray<RegisteredAgent>,
  model: LanguageModelV3,
): Promise<RouteDecision> {
  const catalog = buildAgentCatalog(agents);

  const systemPrompt = `你是 Roll Agent 的智能路由器。根据用户的自然语言请求，从已注册的 Agent 中选择最合适的 Agent 和 Tool。

已注册的 Agent 列表：
${catalog}

规则：
- 选择与用户意图最匹配的 Agent 和 Tool
- 如果用户指定了参数（如数量限制），提取到 input 对象中
- confidence 字段表示你对这个匹配的把握程度（0-1）
- 如果没有合适的 Agent 匹配，confidence 应该很低（< 0.3）`;

  const { output } = await generateText({
    model,
    output: Output.object({ schema: routeDecisionSchema }),
    system: systemPrompt,
    prompt: message,
  });

  if (!output) {
    throw new Error("LLM router: failed to produce structured output");
  }

  return {
    agentName: output.agentName,
    toolName: output.toolName,
    input: output.input,
    confidence: asConfidence(Math.min(1, Math.max(0, output.confidence))),
  };
}
