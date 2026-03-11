import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";

/**
 * 在 MCP Client 上注册 Sampling Handler。
 *
 * 当子 Agent（MCP Server）调用 `createMessage` 请求 LLM 推理时，
 * 该 handler 使用指挥官的 LLM Engine 完成推理并返回结果。
 *
 * @see https://spec.modelcontextprotocol.io/specification/client/sampling/
 */
export function registerSamplingHandler(client: Client, model: LanguageModelV3): void {
  client.setRequestHandler(CreateMessageRequestSchema, async (request): Promise<CreateMessageResult> => {
    // 将 MCP Sampling 消息格式转换为 AI SDK 的 prompt
    const prompt = convertMessagesToPrompt(request.params.messages);

    const maxTokens = request.params.maxTokens;

    const result = await generateText({
      model,
      prompt,
      ...(maxTokens > 0 ? { maxTokens } : {}),
    });

    return {
      role: "assistant",
      content: { type: "text", text: result.text },
      model: result.response.modelId,
      ...(result.finishReason === "length" ? { stopReason: "maxTokens" } : { stopReason: "endTurn" }),
    };
  });
}

/** 将 MCP SamplingMessage[] 转换为纯文本 prompt */
function convertMessagesToPrompt(
  messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>,
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "Assistant" : "User";
    const text = extractTextContent(msg.content);
    parts.push(`${role}: ${text}`);
  }

  return parts.join("\n\n");
}

/** 从 MCP content union 中提取文本 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (typeof content === "object" && content !== null && "type" in content) {
    const typed = content as { type: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      return typed.text;
    }
  }

  return JSON.stringify(content);
}
