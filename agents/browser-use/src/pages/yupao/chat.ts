import type { Page } from "@roll-agent/browser";
import { waitForSelector, typeText, clickElement } from "@roll-agent/browser";
import { YUPAO_SELECTORS } from "./selectors.ts";
import { goToConversation } from "./navigation.ts";

/** 在指定对话中发送回复消息 */
export async function sendReply(
  page: Page,
  conversationId: string,
  message: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await goToConversation(page, conversationId);

    await typeText(page, YUPAO_SELECTORS.chat.input, message);
    await clickElement(page, YUPAO_SELECTORS.chat.sendButton);
    await waitForSelector(page, YUPAO_SELECTORS.chat.messageItem, { timeout: 5_000 });

    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
  }
}
