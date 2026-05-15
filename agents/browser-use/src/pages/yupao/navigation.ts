import {
  navigateTo,
  waitForSelector,
  type BrowserActionPolicyOptions,
  type Page,
} from "@roll-agent/browser";
import { YUPAO_SELECTORS } from "./selectors.ts";

const YUPAO_BASE = "https://www.yupao.com";
const MESSAGE_LIST_URL = `${YUPAO_BASE}/chat`;
const LOGIN_URL = `${YUPAO_BASE}/login`;

/** 导航到消息列表页 */
export async function ensureOnMessageList(
  page: Page,
  options: BrowserActionPolicyOptions = {},
): Promise<void> {
  const currentUrl = page.url();
  if (!currentUrl.includes("/chat")) {
    await navigateTo(page, MESSAGE_LIST_URL, options);
  }
  await waitForSelector(page, YUPAO_SELECTORS.messageList.container, { timeout: 15_000 });
}

/** 导航到登录页 */
export async function goToLoginPage(
  page: Page,
  options: BrowserActionPolicyOptions = {},
): Promise<void> {
  await navigateTo(page, LOGIN_URL, options);
}

/** 导航到指定对话 */
export async function goToConversation(
  page: Page,
  conversationId: string,
  options: BrowserActionPolicyOptions = {},
): Promise<void> {
  const url = `${YUPAO_BASE}/chat?id=${encodeURIComponent(conversationId)}`;
  await navigateTo(page, url, options);
  await waitForSelector(page, YUPAO_SELECTORS.chat.input, { timeout: 15_000 });
}

/** 检测是否已登录 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await waitForSelector(page, YUPAO_SELECTORS.login.loginSuccess, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
