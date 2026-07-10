import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";

export interface SamplingHandlerController {
  /** 更新后续 Sampling 请求使用的 provider 参数；不影响已经发出的请求。 */
  setProviderOptions(providerOptions: SharedV4ProviderOptions | undefined): void;
}

/** 组装传给 AI SDK generateText() 的调用参数（供单测复用，不依赖真实网络请求） */
export function buildSamplingGenerateTextParams(
  model: LanguageModelV4,
  messages: ModelMessage[],
  maxTokens: number,
  providerOptions?: SharedV4ProviderOptions,
) {
  return {
    model,
    messages,
    ...(maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

/**
 * 在 MCP Client 上注册 Sampling Handler。
 *
 * 当子 Agent（MCP Server）调用 `createMessage` 请求 LLM 推理时，
 * 该 handler 使用指挥官的 LLM Engine 完成推理并返回结果。
 *
 * @see https://spec.modelcontextprotocol.io/specification/client/sampling/
 */
export function registerSamplingHandler(
  client: Client,
  model: LanguageModelV4,
  providerOptions?: SharedV4ProviderOptions,
): SamplingHandlerController {
  let currentProviderOptions = providerOptions;

  client.setRequestHandler(
    CreateMessageRequestSchema,
    async (request): Promise<CreateMessageResult> => {
      const messages = convertToModelMessages(request.params.messages);
      const maxTokens = request.params.maxTokens;

      let result;
      try {
        result = await generateText(
          buildSamplingGenerateTextParams(model, messages, maxTokens, currentProviderOptions),
        );
      } catch (error) {
        throw new Error("Sampling handler: LLM generation failed", { cause: error });
      }

      return {
        role: "assistant",
        content: { type: "text", text: result.text },
        model: result.response.modelId,
        ...(result.finishReason === "length"
          ? { stopReason: "maxTokens" }
          : { stopReason: "endTurn" }),
      };
    },
  );

  return {
    setProviderOptions(nextProviderOptions) {
      currentProviderOptions = nextProviderOptions;
    },
  };
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
