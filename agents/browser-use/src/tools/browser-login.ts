import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { PlatformSchema, waitForSelectorVisible, captureLocalStorage } from "@roll-agent/browser";
import type { Page, Platform, BrowserContextManager, SessionStore } from "@roll-agent/browser";
import { getContextManager, getSessionStore } from "../runtime-holder.ts";
import {
  goToLoginPage as goToZhipinLogin,
  isLoggedIn as isZhipinLoggedIn,
} from "../pages/zhipin/navigation.ts";
import { ZHIPIN_SELECTORS } from "../pages/zhipin/selectors.ts";
import {
  goToLoginPage as goToYupaoLogin,
  isLoggedIn as isYupaoLoggedIn,
} from "../pages/yupao/navigation.ts";
import { YUPAO_SELECTORS } from "../pages/yupao/selectors.ts";

const LoginInputSchema = z.object({
  platform: PlatformSchema,
  timeoutSeconds: z.number().default(120),
});

const LoginOutputSchema = z.object({
  success: z.boolean(),
  platform: PlatformSchema,
  message: z.string(),
});

/**
 * 平台登录的通用流程：
 * 1. 检查是否已登录
 * 2. 导航到登录页
 * 3. 等待人工扫码/登录（human-in-the-loop）
 * 4. 登录成功后保存 cookies + localStorage
 */
async function persistSessionState(
  platform: Platform,
  page: Page,
  ctxManager: BrowserContextManager,
  store: SessionStore,
): Promise<void> {
  const context = await ctxManager.getOrCreateContext(platform);
  const [cookies, localStorage] = await Promise.all([context.cookies(), captureLocalStorage(page)]);
  await Promise.all([
    store.saveCookies(platform, cookies),
    store.saveLocalStorage(platform, localStorage),
  ]);
}

async function loginPlatform(opts: {
  platform: Platform;
  page: Page;
  ctxManager: BrowserContextManager;
  store: SessionStore;
  timeoutSeconds: number;
  homeUrl: string;
  isLoggedIn: (page: Page) => Promise<boolean>;
  goToLoginPage: (page: Page) => Promise<void>;
  loginSuccessSelector: string;
}): Promise<{ success: boolean; platform: Platform; message: string }> {
  const { platform, page, ctxManager, store, timeoutSeconds } = opts;

  // 1. 检查是否已登录
  await page.goto(opts.homeUrl);
  if (await opts.isLoggedIn(page)) {
    await persistSessionState(platform, page, ctxManager, store);
    return { success: true, platform, message: "已登录" };
  }

  // 2. 导航到登录页
  await opts.goToLoginPage(page);

  // 3. 等待人工登录
  try {
    await waitForSelectorVisible(page, opts.loginSuccessSelector, {
      timeout: timeoutSeconds * 1000,
    });
  } catch {
    return { success: false, platform, message: `登录超时（${timeoutSeconds}秒）` };
  }

  // 4. 保存 cookies + localStorage
  await persistSessionState(platform, page, ctxManager, store);

  return { success: true, platform, message: "登录成功" };
}

export const browserLogin = defineTool({
  name: "browser_login",
  description: "导航到平台登录页，等待人工扫码/登录完成后自动保存 session",
  input: LoginInputSchema,
  output: LoginOutputSchema,
  execute: async (input, ctx) => {
    const { platform } = input;
    const timeoutSeconds = input.timeoutSeconds ?? 120;
    ctx.logger.info(`Starting login flow for platform: ${platform}`);

    const ctxManager = getContextManager();
    const store = getSessionStore();
    const page = await ctxManager.getPage(platform);

    const platformConfig =
      platform === "zhipin"
        ? {
            homeUrl: "https://www.zhipin.com",
            isLoggedIn: isZhipinLoggedIn,
            goToLoginPage: goToZhipinLogin,
            loginSuccessSelector: ZHIPIN_SELECTORS.login.loginSuccess,
          }
        : {
            homeUrl: "https://www.yupao.com",
            isLoggedIn: isYupaoLoggedIn,
            goToLoginPage: goToYupaoLogin,
            loginSuccessSelector: YUPAO_SELECTORS.login.loginSuccess,
          };

    const result = await loginPlatform({
      platform,
      page,
      ctxManager,
      store,
      timeoutSeconds,
      ...platformConfig,
    });

    if (result.success) {
      ctx.logger.info(`${platform} login successful, session saved`);
    } else {
      ctx.logger.warn(`${platform} login failed: ${result.message}`);
    }

    return result;
  },
});
