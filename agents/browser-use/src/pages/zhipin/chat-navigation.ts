import type { Page } from "@roll-agent/browser";
import { randomDelay } from "./anti-detection.ts";

export interface ChatTarget {
  readonly candidateName: string | undefined;
  readonly index: number | undefined;
}

export interface ChatListItem {
  readonly name: string;
  readonly index: number;
  readonly hasUnread: boolean;
  readonly unreadCount: number;
  readonly lastMessageTime: string;
  readonly messagePreview: string;
}

export interface OpenChatResult extends ChatListItem {
  readonly found: boolean;
  readonly error?: string;
}

function normalizeCandidateName(name: string): string {
  return name.trim().toLocaleLowerCase("zh-CN");
}

function countMatchedCharacters(left: string, right: string): number {
  let matched = 0;
  for (const char of left) {
    if (right.includes(char)) matched += 1;
  }
  return matched;
}

export function selectChatCandidate(
  candidates: ReadonlyArray<ChatListItem>,
  target: ChatTarget,
): ChatListItem | undefined {
  if (target.index !== undefined) {
    return candidates[target.index];
  }

  const rawName = target.candidateName;
  if (!rawName) {
    return undefined;
  }

  const expectedName = normalizeCandidateName(rawName);
  const namedCandidates = candidates.filter((candidate) => candidate.name.length > 0);

  let selected = namedCandidates.find(
    (candidate) => normalizeCandidateName(candidate.name) === expectedName,
  );
  if (selected) return selected;

  selected = namedCandidates.find((candidate) => {
    const actualName = normalizeCandidateName(candidate.name);
    return actualName.includes(expectedName) || expectedName.includes(actualName);
  });
  if (selected) return selected;

  const requiredRatio = expectedName.length <= 2 ? 1 : expectedName.length <= 4 ? 0.75 : 0.6;

  return namedCandidates.find((candidate) => {
    const actualName = normalizeCandidateName(candidate.name);
    const matched = countMatchedCharacters(expectedName, actualName);
    return matched >= Math.ceil(Math.min(expectedName.length, actualName.length) * requiredRatio);
  });
}

export async function ensureChatListLoaded(page: Page): Promise<boolean> {
  if (!page.url().includes("/web/geek/chat") && !page.url().includes("/web/chat")) {
    await page.goto("https://www.zhipin.com/web/geek/chat", { waitUntil: "domcontentloaded" });
  }

  try {
    await page.waitForSelector(".geek-item", { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function getChatCandidates(page: Page): Promise<ReadonlyArray<ChatListItem>> {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".geek-item"));

    return items.map((item, idx) => {
      const nameEl = item.querySelector('[class*="name"], .nickname, .geek-name, .candidate-name');
      const name = nameEl?.textContent?.trim() ?? "";
      const badgeEl = item.querySelector(".badge-count");
      const unreadCount = parseInt(badgeEl?.textContent?.trim() ?? "0", 10) || 0;
      const hasUnread = unreadCount > 0 || item.querySelector(".red-dot") !== null;
      const lastMessageTime = item.querySelector(".time, .time-shadow")?.textContent?.trim() ?? "";
      const messagePreview = (
        item.querySelector(".push-text, .chat-last-msg")?.textContent?.trim() ?? ""
      ).slice(0, 100);

      return {
        name,
        index: idx,
        hasUnread,
        unreadCount,
        lastMessageTime,
        messagePreview,
      };
    });
  });
}

async function clickChatItem(page: Page, index: number): Promise<boolean> {
  return page.evaluate((targetIndex: number) => {
    const items = Array.from(document.querySelectorAll(".geek-item"));
    const target = items[targetIndex];
    if (!target) return false;

    const clickArea = target.querySelector(".chat-item-content") ?? target;
    (clickArea as HTMLElement).click();
    return true;
  }, index);
}

async function waitForChatReady(page: Page, candidateName: string): Promise<void> {
  if (candidateName.length === 0) {
    await randomDelay(page, 500, 900);
    return;
  }

  const expectedName = normalizeCandidateName(candidateName);

  try {
    await page.waitForFunction(
      (name: string) => {
        const selectors = [".name-box", ".geek-name", ".base-name", ".chat-user-name"];

        for (const selector of selectors) {
          const headerText = document.querySelector(selector)?.textContent?.trim();
          if (!headerText) continue;

          const normalized = headerText.trim().toLocaleLowerCase("zh-CN");
          if (normalized.includes(name) || name.includes(normalized)) {
            return true;
          }
        }

        return false;
      },
      expectedName,
      { timeout: 5_000 },
    );
  } catch {
    await randomDelay(page, 800, 1_200);
  }
}

/**
 * 确保指定候选人的聊天窗口已打开。
 *
 * - 有 candidateName/index → 导航到聊天列表 → 选择候选人 → 等待聊天头部切换
 * - 都没有 → 不做任何导航，假设当前窗口已就绪
 */
export async function ensureChatOpen(
  page: Page,
  target: ChatTarget,
): Promise<OpenChatResult | undefined> {
  if (target.candidateName === undefined && target.index === undefined) {
    return undefined;
  }

  const listReady = await ensureChatListLoaded(page);
  if (!listReady) {
    return {
      found: false,
      name: "",
      index: -1,
      hasUnread: false,
      unreadCount: 0,
      lastMessageTime: "",
      messagePreview: "",
      error: "消息列表未加载",
    };
  }

  const candidates = await getChatCandidates(page);
  const selected = selectChatCandidate(candidates, target);
  if (!selected) {
    const who = target.candidateName ?? `index ${target.index}`;
    return {
      found: false,
      name: "",
      index: -1,
      hasUnread: false,
      unreadCount: 0,
      lastMessageTime: "",
      messagePreview: "",
      error: `未找到候选人: ${who}`,
    };
  }

  const clicked = await clickChatItem(page, selected.index);
  if (!clicked) {
    return {
      ...selected,
      found: false,
      error: `打开候选人聊天失败: ${selected.name || `index ${selected.index}`}`,
    };
  }

  await waitForChatReady(page, selected.name);

  return { ...selected, found: true };
}
