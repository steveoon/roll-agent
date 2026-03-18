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

/**
 * 检测是否已登录。
 *
 * 策略：先等 header 渲染（BOSS直聘是 SPA，header 由 JS 动态挂载），
 * 再检测"登录/注册"按钮是否存在。
 *
 * 关键：不能在 header 渲染前就检查 — 按钮不存在可能是因为还没渲染，
 * 而不是因为已登录。
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  // 1. 等 header 渲染出来（SPA 水合后才有内容）
  try {
    await page.waitForSelector("#header, .header-v2, header", {
      state: "visible",
      timeout: 10_000,
    });
  } catch {
    // header 都没渲染出来 — 无法判断，保守返回 false
    return false;
  }

  // 2. header 已渲染，检查"登录/注册"按钮是否存在 — 存在则未登录
  const loginBtn = await page.$(ZHIPIN_SELECTORS.login.notLoggedIn);
  return loginBtn === null;
}
