import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";
import type { ChatGptModel } from "../auth/chatgpt/schemas.ts";

export function assertChatGptFastModeSupported(
  enabled: boolean,
  model?: Pick<ChatGptModel, "slug" | "supportsFastMode">,
): void {
  if (enabled && model?.supportsFastMode !== true) {
    throw new ChatGptAuthError(
      "unsupported_fast_mode",
      `当前账号的模型 "${model?.slug ?? "未知"}" 未提供 Fast 模式；请使用 /fast off 或关闭 runtime.fast-mode。`,
    );
  }
}

/** Fast is a request preference; a response's service_tier does not change it. */
export function withChatGptFastMode(
  options: SharedV4ProviderOptions | undefined,
  enabled: boolean,
): SharedV4ProviderOptions {
  const openai = { ...options?.openai };
  if (enabled) openai.serviceTier = "priority";
  else delete openai.serviceTier;
  return { ...options, openai };
}
