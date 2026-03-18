import type { Page } from "@roll-agent/browser";
import { waitForSelector } from "@roll-agent/browser";
import { ZHIPIN_SELECTORS } from "./selectors.ts";
import { ensureOnMessageList } from "./navigation.ts";

export interface MessageListItem {
  readonly conversationId: string;
  readonly candidateName: string;
  readonly lastMessage: string;
  readonly unreadCount: number;
  readonly timestamp: string;
}

/** 解析 BOSS直聘消息列表页 */
export async function parseMessageList(
  page: Page,
  limit?: number,
): Promise<ReadonlyArray<MessageListItem>> {
  await ensureOnMessageList(page);
  await waitForSelector(page, ZHIPIN_SELECTORS.messageList.item, { timeout: 10_000 });

  const sel = ZHIPIN_SELECTORS.messageList;

  const items = await page.$$eval(
    sel.item,
    (elements: Element[], arg: { sel: typeof sel; maxItems: number | undefined }) => {
      const result: Array<{
        conversationId: string;
        candidateName: string;
        lastMessage: string;
        unreadCount: number;
        timestamp: string;
      }> = [];

      const itemsToProcess = arg.maxItems ? elements.slice(0, arg.maxItems) : elements;

      for (const el of itemsToProcess) {
        const nameEl = el.querySelector(arg.sel.candidateName);
        const msgEl = el.querySelector(arg.sel.lastMessage);
        const badgeEl = el.querySelector(arg.sel.unreadBadge);
        const timeEl = el.querySelector(arg.sel.timestamp);

        const conversationId =
          el.getAttribute("data-id") ??
          el.getAttribute("data-conversation-id") ??
          el
            .querySelector("a")
            ?.getAttribute("href")
            ?.match(/id=([^&]+)/)?.[1] ??
          "";

        result.push({
          conversationId,
          candidateName: nameEl?.textContent?.trim() ?? "",
          lastMessage: msgEl?.textContent?.trim() ?? "",
          unreadCount: parseInt(badgeEl?.textContent?.trim() ?? "0", 10) || 0,
          timestamp: timeEl?.textContent?.trim() ?? "",
        });
      }

      return result;
    },
    { sel, maxItems: limit },
  );

  return items;
}
