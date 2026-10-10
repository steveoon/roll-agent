import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";

const forbiddenBodyFields = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

const terminalInferenceCodes = new Set([
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
  "insufficient_quota",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferenceCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code === "string") return value.code;
  return (
    inferenceCode(value.error) ??
    (isRecord(value.response) ? inferenceCode(value.response.error) : undefined)
  );
}

/** Quota/authorization/capability failures require user action, rather than SDK retries. */
function terminalInferenceError(error: unknown): unknown {
  if (!APICallError.isInstance(error) || !error.isRetryable) return error;
  const code = inferenceCode(error.data);
  if (code === undefined || !terminalInferenceCodes.has(code)) return error;
  return new APICallError({
    message: error.message,
    url: error.url,
    requestBodyValues: error.requestBodyValues,
    isRetryable: false,
    data: error.data,
    cause: error,
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    ...(error.responseHeaders === undefined ? {} : { responseHeaders: error.responseHeaders }),
    ...(error.responseBody === undefined ? {} : { responseBody: error.responseBody }),
  });
}

async function startChatGptStream(
  doStream: () => ReturnType<LanguageModelV4["doStream"]>,
  params: LanguageModelV4CallOptions,
): Promise<LanguageModelV4StreamResult> {
  try {
    return verifiedStream(await doStream(), callWarnings(params));
  } catch (error) {
    throw terminalInferenceError(error);
  }
}

function streamError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (isRecord(value)) {
    if (isRecord(value.error)) return streamError(value.error);
    if (isRecord(value.response) && isRecord(value.response.error)) {
      return streamError(value.response.error);
    }
    if (typeof value.message === "string") {
      return new Error(
        `${typeof value.code === "string" ? `${value.code}: ` : ""}${value.message}`,
      );
    }
  }
  return new Error("ChatGPT Responses stream failed.");
}

function accessTokenWithAbort(
  getToken: () => Promise<string>,
  signal: AbortSignal | null | undefined,
): Promise<string> {
  signal?.throwIfAborted();
  if (signal === null || signal === undefined) return getToken();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(getToken)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort))
      .catch(() => {});
  });
}

function callWarnings(params: LanguageModelV4CallOptions): SharedV4Warning[] {
  const warnings: SharedV4Warning[] =
    params.maxOutputTokens === undefined
      ? []
      : [
          {
            type: "unsupported",
            feature: "maxOutputTokens",
            details:
              "ChatGPT subscription requests do not support a server output-token cap; Roll timeouts and cancellation still apply.",
          },
        ];
  for (const feature of ["temperature", "topP"] as const) {
    if (params[feature] !== undefined) {
      warnings.push({
        type: "unsupported",
        feature,
        details: "ChatGPT subscription requests do not support this sampling parameter.",
      });
    }
  }
  return warnings;
}

function mergeMetadata(
  existing: SharedV4ProviderMetadata | undefined,
  next: SharedV4ProviderMetadata | undefined,
): SharedV4ProviderMetadata | undefined {
  if (next === undefined) return existing;
  const merged = { ...existing };
  for (const [provider, values] of Object.entries(next)) {
    merged[provider] = { ...merged[provider], ...values };
  }
  return merged;
}

/** Use native Responses events to distinguish successful completion from EOF. */
function verifiedStream(
  result: LanguageModelV4StreamResult,
  warnings: SharedV4Warning[],
): LanguageModelV4StreamResult {
  let completed = false;
  let finished = false;
  const pendingToolCalls = new Set<string>();
  return {
    ...result,
    stream: result.stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === "raw") {
            const event = part.rawValue;
            if (isRecord(event)) {
              if (event.type === "response.completed") {
                if (
                  !isRecord(event.response) ||
                  event.response.status !== "completed" ||
                  !isRecord(event.response.usage) ||
                  typeof event.response.usage.input_tokens !== "number" ||
                  typeof event.response.usage.output_tokens !== "number"
                ) {
                  throw new Error(
                    "ChatGPT response.completed is missing a successful status or usage.",
                  );
                }
                completed = true;
              }
              if (
                event.type === "response.output_item.done" &&
                isRecord(event.item) &&
                event.item.type === "function_call" &&
                event.item.status !== "completed"
              ) {
                throw new Error("ChatGPT returned an incomplete local function call.");
              }
              if (
                event.type === "response.failed" &&
                isRecord(event.response) &&
                isRecord(event.response.error)
              ) {
                throw streamError(event);
              }
              if (event.type === "response.incomplete" || event.type === "response.failed") {
                throw new Error(
                  `ChatGPT Responses stream did not complete successfully (${String(event.type)}).`,
                );
              }
            }
            return;
          }
          if (part.type === "error") throw streamError(part.error);
          if (part.type === "tool-input-start") pendingToolCalls.add(part.id);
          if (part.type === "tool-call") pendingToolCalls.delete(part.toolCallId);
          if (part.type === "finish") {
            if (pendingToolCalls.size !== 0) {
              throw new Error("ChatGPT stream ended with an incomplete local function call.");
            }
            if (
              !completed ||
              part.finishReason.unified === "error" ||
              part.usage.inputTokens.total === undefined ||
              part.usage.outputTokens.total === undefined
            ) {
              throw new Error("ChatGPT Responses stream ended without response.completed.");
            }
            finished = true;
          }
          controller.enqueue(
            part.type === "stream-start"
              ? { ...part, warnings: [...part.warnings, ...warnings] }
              : part,
          );
        },
        flush() {
          if (pendingToolCalls.size !== 0) {
            throw new Error("ChatGPT stream ended with an incomplete local function call.");
          }
          if (!completed || !finished) {
            throw new Error("ChatGPT Responses stream ended before successful completion.");
          }
        },
      }),
    ),
  };
}

async function aggregateStream(
  result: LanguageModelV4StreamResult,
): Promise<LanguageModelV4GenerateResult> {
  const content: Array<LanguageModelV4Content | undefined> = [];
  const blocks = new Map<string, Extract<LanguageModelV4Content, { type: "text" | "reasoning" }>>();
  const toolSlots = new Map<string, number>();
  let warnings: SharedV4Warning[] = [];
  let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
  let response: LanguageModelV4GenerateResult["response"] = result.response;
  const reader = result.stream.getReader();
  try {
    while (true) {
      const { value: part, done } = await reader.read();
      if (done) break;
      if (part.type === "text-start" || part.type === "reasoning-start") {
        const type = part.type === "text-start" ? "text" : "reasoning";
        const block: Extract<LanguageModelV4Content, { type: "text" | "reasoning" }> = {
          type,
          text: "",
          ...(part.providerMetadata === undefined
            ? {}
            : { providerMetadata: part.providerMetadata }),
        };
        blocks.set(`${type}:${part.id}`, block);
        content.push(block);
      } else if (
        part.type === "text-delta" ||
        part.type === "text-end" ||
        part.type === "reasoning-delta" ||
        part.type === "reasoning-end"
      ) {
        const type = part.type.startsWith("text-") ? "text" : "reasoning";
        const block = blocks.get(`${type}:${part.id}`);
        if (block === undefined) throw new Error(`ChatGPT stream has an unmatched ${part.type}.`);
        if ("delta" in part) block.text += part.delta;
        const metadata = mergeMetadata(block.providerMetadata, part.providerMetadata);
        if (metadata !== undefined) block.providerMetadata = metadata;
      } else if (part.type === "tool-input-start") {
        toolSlots.set(part.id, content.length);
        content.push(undefined);
      } else if (part.type === "tool-call") {
        const slot = toolSlots.get(part.toolCallId);
        if (slot === undefined) content.push(part);
        else content[slot] = part;
      } else if (part.type === "stream-start") {
        warnings = part.warnings;
      } else if (part.type === "response-metadata") {
        const { type: _type, ...metadata } = part;
        response = { ...response, ...metadata };
      } else if (part.type === "finish") {
        finish = part;
      } else if (part.type === "error") {
        throw part.error;
      } else if (
        part.type === "tool-result" ||
        part.type === "tool-approval-request" ||
        part.type === "custom" ||
        part.type === "file" ||
        part.type === "reasoning-file" ||
        part.type === "source"
      ) {
        content.push(part);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (finish === undefined || content.some((part) => part === undefined)) {
    throw new Error("ChatGPT stream is missing a finish event or a completed tool call.");
  }
  return {
    content: content.filter((part): part is LanguageModelV4Content => part !== undefined),
    finishReason: finish.finishReason,
    usage: finish.usage,
    warnings,
    ...(finish.providerMetadata === undefined ? {} : { providerMetadata: finish.providerMetadata }),
    ...(result.request === undefined ? {} : { request: result.request }),
    ...(response === undefined ? {} : { response }),
  };
}

/** Every request obtains the current account token; no API-key fallback is possible. */
export function createChatGptModel(options: {
  modelId: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): LanguageModelV4 {
  const send = options.fetch ?? globalThis.fetch;
  const authenticatedFetch: typeof globalThis.fetch = async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (target.origin !== "https://api.openai.com" || target.pathname !== "/v1/responses") {
      throw new Error("ChatGPT token can only be sent to the official Responses endpoint.");
    }
    init?.signal?.throwIfAborted();
    const token = await accessTokenWithAbort(options.getAccessToken, init?.signal);
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (typeof init?.body !== "string") {
      throw new Error("ChatGPT Responses requests require a JSON body.");
    }
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body)) throw new Error("Invalid ChatGPT Responses request body.");
    for (const field of forbiddenBodyFields) delete body[field];
    body.store = false;
    body.stream = true;
    return send(url, { ...init, redirect: "error", headers, body: JSON.stringify(body) });
  };
  const openai = createOpenAI({
    // The SDK requires an API key to serialize headers. It is always replaced
    // before the only HTTP transport, and never reads OPENAI_API_KEY/BASE_URL.
    apiKey: "chatgpt-subscription-transport",
    baseURL: "https://api.openai.com/v1",
    fetch: authenticatedFetch,
  });
  return wrapLanguageModel({
    model: openai.responses(options.modelId),
    providerId: "chatgpt.responses",
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => {
        if (params.tools?.some((tool) => tool.type !== "function")) {
          throw new Error("ChatGPT subscription supports Roll local function tools only.");
        }
        const openaiOptions = { ...params.providerOptions?.openai };
        // Remove stateful options before SDK serialization: deleting only their
        // wire fields would already have caused the SDK to omit local history.
        for (const field of forbiddenBodyFields) {
          delete openaiOptions[
            field.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
          ];
        }
        return {
          ...params,
          includeRawChunks: true,
          prompt: params.prompt.map((message) =>
            message.role !== "assistant"
              ? message
              : {
                  ...message,
                  content: message.content.map((part) =>
                    part.type !== "tool-call"
                      ? part
                      : {
                          ...part,
                          providerOptions: {
                            ...part.providerOptions,
                            openai: { ...part.providerOptions?.openai, namespace: "roll" },
                          },
                        },
                  ),
                },
          ),
          providerOptions: {
            ...params.providerOptions,
            openai: {
              ...openaiOptions,
              store: false,
              systemMessageMode: "developer",
              include: ["reasoning.encrypted_content"],
            },
          },
          ...(params.tools === undefined
            ? {}
            : {
                tools: params.tools.map((tool) => {
                  if (tool.type !== "function") {
                    throw new Error("Unsupported ChatGPT provider tool.");
                  }
                  return {
                    ...tool,
                    providerOptions: {
                      ...tool.providerOptions,
                      openai: {
                        ...tool.providerOptions?.openai,
                        namespace: {
                          name: "roll",
                          description:
                            "Local tools executed by Roll with its existing approval policy.",
                        },
                      },
                    },
                  };
                }),
              }),
        };
      },
      wrapStream: async ({ doStream, params }) => startChatGptStream(doStream, params),
      wrapGenerate: async ({ doStream, params }) =>
        aggregateStream(await startChatGptStream(doStream, params)),
    },
  });
}
