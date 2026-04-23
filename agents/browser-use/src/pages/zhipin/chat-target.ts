import type { Page } from "@roll-agent/browser";

export interface ZhipinChatTarget {
  readonly conversationId: string;
  readonly candidateId: string;
  readonly candidateName: string;
}

export interface ZhipinActiveChatPanel {
  readonly candidateName: string;
}

const SELECTED_CHAT_ITEM_SELECTOR = ".geek-item.selected";

export async function getSelectedChatTarget(page: Page): Promise<ZhipinChatTarget | null> {
  try {
    await page.waitForSelector(SELECTED_CHAT_ITEM_SELECTOR, { timeout: 5_000 });
  } catch {
    return null;
  }

  const target = await page.evaluate(() => {
    const selected = document.querySelector(".geek-item.selected");
    if (!selected) {
      return null;
    }

    const conversationId =
      selected.getAttribute("data-id") ??
      selected.closest('[role="listitem"]')?.getAttribute("key") ??
      "";
    const candidateId =
      selected.getAttribute("data-geek") ??
      selected.querySelector("[data-geek]")?.getAttribute("data-geek") ??
      conversationId;
    const candidateName =
      selected
        .querySelector('[class*="name"], .nickname, .geek-name, .candidate-name')
        ?.textContent?.trim() ?? "";

    return { conversationId, candidateId, candidateName };
  });

  if (
    !target ||
    typeof target.conversationId !== "string" ||
    typeof target.candidateId !== "string" ||
    target.conversationId.length === 0 ||
    target.candidateId.length === 0
  ) {
    return null;
  }

  return target;
}

export async function getActiveChatPanel(page: Page): Promise<ZhipinActiveChatPanel | null> {
  const panel = await page.evaluate(() => {
    const rootSelectors = [".chat-conversation", ".conversation-box", ".conversation-message"];
    const nameSelectors = [
      ".base-info-single-detial .name-box",
      ".base-info-content .name-box",
      ".base-info-single-container .name-box",
      ".base-info-content .base-name",
      ".chat-user-name",
      ".name-box",
      ".base-name",
    ];

    for (const rootSelector of rootSelectors) {
      const root = document.querySelector(rootSelector);
      if (!root) continue;

      for (const nameSelector of nameSelectors) {
        const candidateName = root.querySelector(nameSelector)?.textContent?.trim() ?? "";
        if (candidateName.length > 0) {
          return { candidateName };
        }
      }
    }

    return null;
  });

  if (!panel || typeof panel.candidateName !== "string" || panel.candidateName.length === 0) {
    return null;
  }

  return panel;
}
