import type { Page } from "@roll-agent/browser";
import { waitForSelector, typeText, clickElement } from "@roll-agent/browser";
import { ZHIPIN_SELECTORS } from "./selectors.ts";
import { goToConversation } from "./navigation.ts";

/** 在指定对话中发送回复消息 */
export async function sendReply(
  page: Page,
  conversationId: string,
  message: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await goToConversation(page, conversationId);

    // 输入消息
    await typeText(page, ZHIPIN_SELECTORS.chat.input, message);

    // 点击发送
    await clickElement(page, ZHIPIN_SELECTORS.chat.sendButton);

    // 等待消息出现在对话中（验证发送成功）
    await waitForSelector(page, ZHIPIN_SELECTORS.chat.messageItem, { timeout: 5_000 });

    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
  }
}

/** 读取当前对话中的消息内容 */
export async function readChatMessages(page: Page): Promise<ReadonlyArray<string>> {
  await waitForSelector(page, ZHIPIN_SELECTORS.chat.messageItem, { timeout: 10_000 });

  return page.$$eval(ZHIPIN_SELECTORS.chat.messageText, (elements: Element[]) =>
    elements.map((el: Element) => el.textContent?.trim() ?? ""),
  );
}
