import {
  clickElement,
  isBrowserActionPolicyError,
  typeText,
  waitForSelector,
  type BrowserActionPolicyOptions,
  type Page,
} from "@roll-agent/browser";
import { YUPAO_SELECTORS } from "./selectors.ts";
import { goToConversation } from "./navigation.ts";

/** 在指定对话中发送回复消息 */
export async function sendReply(
  page: Page,
  conversationId: string,
  message: string,
  options: BrowserActionPolicyOptions = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    await goToConversation(page, conversationId, options);

    await typeText(page, YUPAO_SELECTORS.chat.input, message, options);
    await clickElement(page, YUPAO_SELECTORS.chat.sendButton, options);
    await waitForSelector(page, YUPAO_SELECTORS.chat.messageItem, { timeout: 5_000 });

    return { success: true };
  } catch (err) {
    if (isBrowserActionPolicyError(err)) {
      throw err;
    }

    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
  }
}
