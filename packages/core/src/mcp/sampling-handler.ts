import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import { generateText } from "ai";
import type { ModelMessage } from "ai";
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
    const messages = convertToModelMessages(request.params.messages);
    const maxTokens = request.params.maxTokens;

    let result;
    try {
      result = await generateText({
        model,
        messages,
        ...(maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
      });
    } catch (error) {
      throw new Error("Sampling handler: LLM generation failed", { cause: error });
    }

    return {
      role: "assistant",
      content: { type: "text", text: result.text },
      model: result.response.modelId,
      ...(result.finishReason === "length" ? { stopReason: "maxTokens" } : { stopReason: "endTurn" }),
    };
  });
}

/** 将 MCP SamplingMessage[] 转换为 AI SDK ModelMessage[] */
function convertToModelMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>,
): ModelMessage[] {
  return messages.map((msg): ModelMessage => {
    const text = extractTextContent(msg.content);

    if (msg.role === "assistant") {
      return { role: "assistant", content: [{ type: "text", text }] };
    }
    return { role: "user", content: [{ type: "text", text }] };
  });
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
