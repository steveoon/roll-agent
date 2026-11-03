import type { AgentSessionOptions } from "@roll-agent/runtime";
import { isOpenAIReasoningModel } from "./providers.ts";

type ResolvePresentation = NonNullable<AgentSessionOptions["resolveReasoningPresentation"]>;
type Presentation = NonNullable<ReturnType<ResolvePresentation>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textDelta(value: unknown): string[] {
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function chatReasoningContent(raw: Record<string, unknown>): string[] {
  const choice: unknown = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  return isRecord(choice) && isRecord(choice.delta)
    ? textDelta(choice.delta.reasoning_content)
    : [];
}

function geminiThoughtSummaries(raw: Record<string, unknown>): string[] {
  const candidate: unknown = Array.isArray(raw.candidates) ? raw.candidates[0] : undefined;
  if (
    !isRecord(candidate) ||
    !isRecord(candidate.content) ||
    !Array.isArray(candidate.content.parts)
  ) {
    return [];
  }
  return candidate.content.parts.flatMap((part: unknown) =>
    isRecord(part) && part.thought === true ? textDelta(part.text) : [],
  );
}

function presentation(
  kind: Presentation["kind"],
  readDeltas: (raw: Record<string, unknown>) => readonly string[],
): Presentation {
  return {
    kind,
    readDeltas: (raw) => (isRecord(raw) ? readDeltas(raw) : []),
  };
}

/** Bind the advertised capability and the native field reader to the same resolved chat model. */
export const resolveReasoningPresentation: ResolvePresentation = (model, options) => {
  const adapter = model.provider;
  if (adapter === "openai.responses") {
    const openai = options?.openai;
    const capable = openai?.forceReasoning ?? isOpenAIReasoningModel(model.modelId);
    // An explicit null disables the SDK's automatic summary for nonzero effort.
    const requested =
      openai?.reasoningSummary === undefined
        ? typeof openai?.reasoningEffort === "string"
        : typeof openai.reasoningSummary === "string";
    if (capable !== true || !requested || openai?.reasoningEffort === "none") return undefined;
    return presentation("summary", (raw) =>
      raw.type === "response.reasoning_summary_text.delta" ? textDelta(raw.delta) : [],
    );
  }
  if (adapter === "anthropic.messages") {
    const thinking = options?.anthropic?.thinking;
    if (
      !isRecord(thinking) ||
      thinking.display !== "summarized" ||
      (thinking.type !== "adaptive" && thinking.type !== "enabled")
    ) {
      return undefined;
    }
    return presentation("summary", (raw) =>
      raw.type === "content_block_delta" &&
      isRecord(raw.delta) &&
      raw.delta.type === "thinking_delta"
        ? textDelta(raw.delta.thinking)
        : [],
    );
  }
  if (adapter === "google.generative-ai") {
    const thinking = options?.google?.thinkingConfig;
    if (!isRecord(thinking) || thinking.includeThoughts !== true) return undefined;
    return presentation("summary", geminiThoughtSummaries);
  }
  // xAI documents both native events as summaries for this model specifically.
  // The installed adapter sends effort, not reasoning.summary, in the HTTP request.
  if (
    adapter === "xai.responses" &&
    model.modelId === "grok-4.7" &&
    options?.xai?.reasoningEffort !== undefined &&
    options.xai.reasoningEffort !== "none"
  ) {
    return presentation("summary", (raw) =>
      raw.type === "response.reasoning_summary_text.delta" ||
      raw.type === "response.reasoning_text.delta"
        ? textDelta(raw.delta)
        : [],
    );
  }
  if (
    (adapter === "deepseek.chat" &&
      isRecord(options?.deepseek?.thinking) &&
      options.deepseek.thinking.type === "enabled") ||
    (adapter === "alibaba.chat" && options?.alibaba?.enableThinking === true)
  ) {
    return presentation("text", chatReasoningContent);
  }
  return undefined;
};
