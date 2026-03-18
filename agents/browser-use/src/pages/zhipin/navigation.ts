import type { Page } from "@roll-agent/browser";
import { navigateTo, waitForSelector } from "@roll-agent/browser";
import { ZHIPIN_SELECTORS } from "./selectors.ts";

const ZHIPIN_BASE = "https://www.zhipin.com";
const MESSAGE_LIST_URL = `${ZHIPIN_BASE}/web/geek/chat`;
const LOGIN_URL = `${ZHIPIN_BASE}/web/user/?ka=header-login`;

/** 导航到消息列表页（如果不在该页则跳转） */
export async function ensureOnMessageList(page: Page): Promise<void> {
  const currentUrl = page.url();
  if (!currentUrl.includes("/web/geek/chat")) {
    await navigateTo(page, MESSAGE_LIST_URL);
  }
  await waitForSelector(page, ZHIPIN_SELECTORS.messageList.container, { timeout: 15_000 });
}

/** 导航到登录页 */
export async function goToLoginPage(page: Page): Promise<void> {
  await navigateTo(page, LOGIN_URL);
}

/** 导航到指定对话 */
export async function goToConversation(page: Page, conversationId: string): Promise<void> {
  const url = `${ZHIPIN_BASE}/web/geek/chat?id=${encodeURIComponent(conversationId)}`;
  await navigateTo(page, url);
  await waitForSelector(page, ZHIPIN_SELECTORS.chat.input, { timeout: 15_000 });
}

/** 检测是否已登录（检查页面上有无用户信息元素） */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await waitForSelector(page, ZHIPIN_SELECTORS.login.loginSuccess, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
