import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContextManager, Page } from "@roll-agent/browser";
import { randomDelay } from "./anti-detection.ts";
import { getActiveChatPanel, getSelectedChatTarget } from "./chat-target.ts";
import { moveVisualCursorToLocator, showVisualClickOnLocator } from "../../visual-cursor.ts";

export interface ChatTarget {
  readonly conversationId: string | undefined;
  readonly candidateName: string | undefined;
  readonly index: number | undefined;
}

export interface ChatListItem {
  readonly conversationId: string;
  readonly candidateId: string;
  readonly name: string;
  readonly index: number;
  readonly position: string;
  readonly hasUnread: boolean;
  readonly unreadCount: number;
  readonly lastMessageTime: string;
  readonly messagePreview: string;
}

export interface OpenChatResult extends ChatListItem {
  readonly found: boolean;
  readonly error?: string;
}

const ZHIPIN_CHAT_URL = "https://www.zhipin.com/web/chat/index";
const CHAT_LIST_SELECTOR = ".chat-list-wrap, .geek-item";
const MESSAGE_ENTRY_TEXT = new Set(["消息"]);
const CHAT_ENTRY_MARKER_ATTR = "data-roll-chat-entry-target";
const CHAT_ITEM_MARKER_ATTR = "data-roll-chat-item-target";

function normalizeCandidateName(name: string): string {
  return name.trim().toLocaleLowerCase("zh-CN");
}

function namesCompatible(expectedName: string, actualName: string): boolean {
  const expected = normalizeCandidateName(expectedName);
  const actual = normalizeCandidateName(actualName);
  return (
    expected.length > 0 &&
    actual.length > 0 &&
    (expected === actual || expected.includes(actual) || actual.includes(expected))
  );
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
  if (target.conversationId !== undefined) {
    const byConversation = candidates.find(
      (candidate) => candidate.conversationId === target.conversationId,
    );
    if (byConversation) {
      return byConversation;
    }
  }

  const rawName = target.candidateName;
  if (rawName) {
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

    selected = namedCandidates.find((candidate) => {
      const actualName = normalizeCandidateName(candidate.name);
      const matched = countMatchedCharacters(expectedName, actualName);
      return matched >= Math.ceil(Math.min(expectedName.length, actualName.length) * requiredRatio);
    });
    if (selected) return selected;
  }

  if (target.index !== undefined) {
    return candidates[target.index];
  }

  return undefined;
}

function isChatPageUrl(url: string): boolean {
  return url.includes("/web/chat/index");
}

async function waitForChatList(page: Page, timeout = 10_000): Promise<boolean> {
  try {
    await page.waitForSelector(CHAT_LIST_SELECTOR, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function findOpenChatTab(
  ctxManager: BrowserContextManager,
  currentPage?: Page,
): Promise<Page | undefined> {
  const pages = await ctxManager.listAttachedPages();
  const matched = pages.find((page) => page !== currentPage && isChatPageUrl(page.url()));
  if (!matched) {
    return undefined;
  }

  return await ctxManager.selectAttachedPage("zhipin", ctxManager.getPageId(matched));
}

async function clearTemporaryMarker(page: Page, attr: string): Promise<void> {
  await page
    .evaluate((markerAttr: string) => {
      document.querySelectorAll(`[${markerAttr}]`).forEach((element) => {
        element.removeAttribute(markerAttr);
      });
    }, attr)
    .catch(() => {});
}

async function clickMarkedElement(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  await moveVisualCursorToLocator(page, target);
  await target.hover();
  await randomDelay(page, 200, 400);
  await showVisualClickOnLocator(page, target);
  await target.click();
}

async function clickMessageEntry(page: Page): Promise<boolean> {
  const markedTarget = await page.evaluate(
    (args: { markerAttr: string; messageLabels: string[] }) => {
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const hasMessageText = (text: string): boolean =>
        args.messageLabels.some((label) => text === label || text.includes(label));

      document.querySelectorAll(`[${args.markerAttr}]`).forEach((element) => {
        element.removeAttribute(args.markerAttr);
      });

      const directTargets = Array.from(
        document.querySelectorAll('a[href*="/web/chat/index"]'),
      );
      for (const element of directTargets) {
        if (!isVisible(element)) {
          continue;
        }

        element.setAttribute(args.markerAttr, "true");
        return { found: true as const, selector: `[${args.markerAttr}="true"]` };
      }

      const fallbackTargets = Array.from(
        document.querySelectorAll('a, button, [role="link"], [role="button"], span, div'),
      );
      for (const element of fallbackTargets) {
        const text = element.textContent?.trim() ?? "";
        if (!hasMessageText(text) || !isVisible(element)) {
          continue;
        }

        element.setAttribute(args.markerAttr, "true");
        return { found: true as const, selector: `[${args.markerAttr}="true"]` };
      }

      return { found: false as const };
    },
    { markerAttr: CHAT_ENTRY_MARKER_ATTR, messageLabels: [...MESSAGE_ENTRY_TEXT] },
  );

  if (!markedTarget.found) {
    return false;
  }

  try {
    await clickMarkedElement(page, markedTarget.selector);
    return true;
  } finally {
    await clearTemporaryMarker(page, CHAT_ENTRY_MARKER_ATTR);
  }
}

function isErrAborted(error: unknown): boolean {
  return error instanceof Error && /ERR_ABORTED/i.test(error.message);
}

async function softGotoChatList(page: Page): Promise<boolean> {
  try {
    await page.goto(ZHIPIN_CHAT_URL, { waitUntil: "domcontentloaded" });
    return true;
  } catch (error) {
    if (!isErrAborted(error)) {
      return false;
    }

    if (isChatPageUrl(page.url())) {
      return true;
    }

    return await waitForChatList(page, 2_000);
  }
}

async function tryReachChatListViaUi(
  ctxManager: BrowserContextManager,
  page: Page,
): Promise<boolean> {
  const clicked = await clickMessageEntry(page);
  if (!clicked) {
    return false;
  }

  if (await waitForChatList(page, 5_000)) {
    return true;
  }

  const reusedPage = await findOpenChatTab(ctxManager, page);
  if (!reusedPage) {
    return false;
  }

  return await waitForChatList(reusedPage, 5_000);
}

/**
 * 聊天页进入策略：
 * 1. 当前页已经是聊天页
 * 2. 复用已打开的聊天 tab
 * 3. 在当前 BOSS 页面点击“消息”入口
 * 4. 最后才用 goto 兜底；若 `ERR_ABORTED`，则检查页面是否已进入可用状态
 */
export async function ensureChatListLoaded(
  ctxManager: BrowserContextManager,
  page: Page,
): Promise<boolean> {
  if (isChatPageUrl(page.url()) && (await waitForChatList(page))) {
    return true;
  }

  const reusedPage = await findOpenChatTab(ctxManager, page);
  if (reusedPage && (await waitForChatList(reusedPage))) {
    return true;
  }

  if (await tryReachChatListViaUi(ctxManager, page)) {
    return true;
  }

  if (!(await softGotoChatList(page))) {
    return false;
  }

  if (await waitForChatList(page)) {
    return true;
  }

  await delay(300);
  const reusedAfterGoto = await findOpenChatTab(ctxManager, page);
  if (!reusedAfterGoto) {
    return false;
  }

  return await waitForChatList(reusedAfterGoto, 5_000);
}

export async function getChatCandidates(page: Page): Promise<ReadonlyArray<ChatListItem>> {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".geek-item"));

    return items.map((item, idx) => {
      const conversationId =
        item.getAttribute("data-id") ??
        item.closest('[role="listitem"]')?.getAttribute("key") ??
        "";
      const candidateId =
        item.getAttribute("data-geek") ??
        item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
        conversationId;
      const nameEl = item.querySelector('[class*="name"], .nickname, .geek-name, .candidate-name');
      const name = nameEl?.textContent?.trim() ?? "";
      const position = item.querySelector(".source-job")?.textContent?.trim() ?? "";
      const badgeEl = item.querySelector(".badge-count");
      const unreadCount = parseInt(badgeEl?.textContent?.trim() ?? "0", 10) || 0;
      const hasUnread = unreadCount > 0 || item.querySelector(".red-dot") !== null;
      const lastMessageTime = item.querySelector(".time, .time-shadow")?.textContent?.trim() ?? "";
      const messagePreview = (
        item.querySelector(".push-text, .chat-last-msg")?.textContent?.trim() ?? ""
      ).slice(0, 100);

      return {
        conversationId,
        candidateId,
        name,
        index: idx,
        position,
        hasUnread,
        unreadCount,
        lastMessageTime,
        messagePreview,
      };
    });
  });
}

async function clickChatItem(
  page: Page,
  targetCandidate: Pick<ChatListItem, "conversationId" | "index">,
): Promise<boolean> {
  const markedTarget = await page.evaluate(
    (args: { markerAttr: string; targetConversationId: string; targetIndex: number }) => {
      document.querySelectorAll(`[${args.markerAttr}]`).forEach((element) => {
        element.removeAttribute(args.markerAttr);
      });

      const items = Array.from(document.querySelectorAll(".geek-item"));
      const target =
        items.find((item) => {
          const conversationId =
            item.getAttribute("data-id") ??
            item.closest('[role="listitem"]')?.getAttribute("key") ??
            "";
          return conversationId === args.targetConversationId;
        }) ?? items[args.targetIndex];
      if (!target) {
        return { found: false as const };
      }

      const clickArea = target.querySelector(".chat-item-content") ?? target;
      clickArea.setAttribute(args.markerAttr, "true");
      return { found: true as const, selector: `[${args.markerAttr}="true"]` };
    },
    {
      markerAttr: CHAT_ITEM_MARKER_ATTR,
      targetConversationId: targetCandidate.conversationId,
      targetIndex: targetCandidate.index,
    },
  );

  if (!markedTarget.found) {
    return false;
  }

  try {
    await clickMarkedElement(page, markedTarget.selector);
    return true;
  } finally {
    await clearTemporaryMarker(page, CHAT_ITEM_MARKER_ATTR);
  }
}

async function waitForChatReady(page: Page, candidate: ChatListItem): Promise<boolean> {
  if (candidate.conversationId.length === 0 && candidate.name.length === 0) {
    await randomDelay(page, 500, 900);
    return true;
  }

  try {
    await page.waitForFunction(
      (args: { conversationId: string; candidateName: string }) => {
        const normalize = (value: string): string => value.trim().toLocaleLowerCase("zh-CN");
        const matchNames = (expectedName: string, actualName: string): boolean => {
          const expected = normalize(expectedName);
          const actual = normalize(actualName);
          return (
            expected.length > 0 &&
            actual.length > 0 &&
            (expected === actual || expected.includes(actual) || actual.includes(expected))
          );
        };
        const readPanelName = (): string => {
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
              const text = root.querySelector(nameSelector)?.textContent?.trim() ?? "";
              if (text.length > 0) {
                return text;
              }
            }
          }

          return "";
        };

        const selected = document.querySelector(".geek-item.selected");
        const selectedConversationId =
          selected?.getAttribute("data-id") ??
          selected?.closest('[role="listitem"]')?.getAttribute("key") ??
          "";
        const selectedMatches =
          args.conversationId.length === 0 || selectedConversationId === args.conversationId;
        const panelName = readPanelName();
        const panelMatches =
          args.candidateName.length === 0 || matchNames(args.candidateName, panelName);

        return selectedMatches && panelMatches;
      },
      {
        conversationId: candidate.conversationId,
        candidateName: candidate.name,
      },
      { timeout: 5_000 },
    );
    return true;
  } catch {
    await randomDelay(page, 800, 1_200);
    return false;
  }
}

/**
 * 确保指定候选人的聊天窗口已打开。
 *
 * - 有 candidateName/index → 导航到聊天列表 → 选择候选人 → 等待聊天头部切换
 * - 都没有 → 不做任何导航，假设当前窗口已就绪
 */
export async function ensureChatOpen(
  ctxManager: BrowserContextManager,
  page: Page,
  target: ChatTarget,
): Promise<OpenChatResult | undefined> {
  if (
    target.conversationId === undefined &&
    target.candidateName === undefined &&
    target.index === undefined
  ) {
    return undefined;
  }

  const listReady = await ensureChatListLoaded(ctxManager, page);
  if (!listReady) {
    return {
      found: false,
      conversationId: "",
      candidateId: "",
      name: "",
      index: -1,
      position: "",
      hasUnread: false,
      unreadCount: 0,
      lastMessageTime: "",
      messagePreview: "",
      error: "消息列表未加载",
    };
  }

  const activePage = await ctxManager.getPage("zhipin");
  const candidates = await getChatCandidates(activePage);
  const selected = selectChatCandidate(candidates, target);
  if (!selected) {
    const who = target.conversationId ?? target.candidateName ?? `index ${target.index}`;
    return {
      found: false,
      conversationId: "",
      candidateId: "",
      name: "",
      index: -1,
      position: "",
      hasUnread: false,
      unreadCount: 0,
      lastMessageTime: "",
      messagePreview: "",
      error: `未找到候选人: ${who}`,
    };
  }

  const clicked = await clickChatItem(activePage, selected);
  if (!clicked) {
    return {
      ...selected,
      found: false,
      error: `打开候选人聊天失败: ${selected.name || `index ${selected.index}`}`,
    };
  }

  let ready = await waitForChatReady(activePage, selected);
  if (!ready) {
    const retried = await clickChatItem(activePage, selected);
    if (retried) {
      ready = await waitForChatReady(activePage, selected);
    }
  }

  if (!ready) {
    return {
      ...selected,
      found: false,
      error: `打开候选人聊天后，右侧会话未同步切换到 ${selected.name || selected.conversationId}`,
    };
  }

  const syncedTarget = await getSelectedChatTarget(activePage);
  if (!syncedTarget || syncedTarget.conversationId !== selected.conversationId) {
    return {
      ...selected,
      found: false,
      error: `当前选中会话与目标会话不一致: ${selected.name || selected.conversationId}`,
    };
  }

  const activePanel = await getActiveChatPanel(activePage);
  if (
    selected.name.length > 0 &&
    (!activePanel || !namesCompatible(selected.name, activePanel.candidateName))
  ) {
    return {
      ...selected,
      found: false,
      error: `右侧聊天面板仍未切换到 ${selected.name}`,
    };
  }

  return { ...selected, found: true };
}
