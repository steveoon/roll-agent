import type { LanguageModelV4CallOptions, SharedV4ProviderOptions } from "@ai-sdk/provider";

type Prompt = LanguageModelV4CallOptions["prompt"];
type AssistantPart = Extract<Prompt[number], { readonly role: "assistant" }>["content"][number];

function isForeignEmptySignaturePart(part: AssistantPart, providerKey: string): boolean {
  return (
    (part.type === "text" || part.type === "reasoning") &&
    part.text.length === 0 &&
    part.providerOptions !== undefined &&
    Object.keys(part.providerOptions).length > 0 &&
    part.providerOptions[providerKey] === undefined
  );
}

/**
 * Google Gemini emits empty `reasoning` parts carrying only `google.thoughtSignature`
 * that must be replayed verbatim on subsequent Google turns. Other namespaces
 * (even with a field named `thoughtSignature`) and stateful server references
 * (`openai.itemId`, `reasoningEncryptedContent`, etc.) are never retained.
 */
export function shouldRetainEmptyReasoningPart(providerOptions: SharedV4ProviderOptions): boolean {
  const keys = Object.keys(providerOptions);
  if (keys.length !== 1 || keys[0] !== "google") {
    return false;
  }
  const google = providerOptions.google;
  if (typeof google !== "object" || google === null || Array.isArray(google)) {
    return false;
  }
  const googleKeys = Object.keys(google);
  return (
    googleKeys.length === 1 &&
    googleKeys[0] === "thoughtSignature" &&
    typeof google.thoughtSignature === "string" &&
    google.thoughtSignature.length > 0
  );
}

/**
 * AI SDK and Roll preserve empty assistant text/reasoning parts when a provider
 * attaches opaque replay metadata such as `google.thoughtSignature`. When the
 * conversation switches to another provider, omit foreign empty signature carriers
 * (and any assistant message that becomes empty) before adapter serialization.
 */
export function omitForeignEmptyAssistantTextParts(prompt: Prompt, providerKey: string): Prompt {
  if (
    !prompt.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => isForeignEmptySignaturePart(part, providerKey)),
    )
  ) {
    return prompt;
  }
  return prompt.flatMap((message): Prompt[number][] => {
    if (message.role !== "assistant") return [message];
    const content = message.content.filter(
      (part) => !isForeignEmptySignaturePart(part, providerKey),
    );
    if (content.length === 0) return [];
    return content.length === message.content.length ? [message] : [{ ...message, content }];
  });
}
