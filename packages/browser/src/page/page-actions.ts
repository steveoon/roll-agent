import type { Page } from "playwright-core";
import type { PageSnapshot } from "../types/index.ts";
import { assertBrowserActionPreflight, truncateTextToUtf8Bytes } from "../runtime/security.ts";
import type { BrowserActionPolicyOptions } from "../runtime/security.ts";

/** 获取当前页面快照（URL + title + HTML） */
export async function snapshot(
  page: Page,
  options: { readonly maxContentBytes?: number } = {},
): Promise<PageSnapshot> {
  const [url, title, html] = await Promise.all([
    Promise.resolve(page.url()),
    page.title(),
    page.content(),
  ]);

  if (options.maxContentBytes === undefined) {
    return { url, title, html };
  }

  const truncated = truncateTextToUtf8Bytes(html, options.maxContentBytes);
  return {
    url,
    title,
    html: truncated.text,
    truncated: truncated.truncated,
    originalBytes: truncated.originalBytes,
    returnedBytes: truncated.returnedBytes,
  };
}

/** 点击页面元素 */
export async function clickElement(
  page: Page,
  selector: string,
  options: BrowserActionPolicyOptions = {},
): Promise<void> {
  assertBrowserActionPreflight({
    ...options,
    action: "click",
    target: selector,
  });
  await page.click(selector);
}

/** 在输入框中输入文本（先清空再输入） */
export async function typeText(
  page: Page,
  selector: string,
  text: string,
  options: BrowserActionPolicyOptions = {},
): Promise<void> {
  assertBrowserActionPreflight({
    ...options,
    action: "type",
    target: selector,
  });
  await page.fill(selector, text);
}

/** 导航到指定 URL */
export async function navigateTo(
  page: Page,
  url: string,
  options: {
    waitUntil?: "load" | "domcontentloaded" | "networkidle";
  } & BrowserActionPolicyOptions = {},
): Promise<void> {
  assertBrowserActionPreflight({
    ...options,
    action: "navigate",
    target: url,
    url,
  });
  await page.goto(url, { waitUntil: options?.waitUntil ?? "domcontentloaded" });
}

/** 等待选择器出现在 DOM 中 */
export async function waitForSelector(
  page: Page,
  selector: string,
  options?: { timeout?: number; state?: "attached" | "visible" | "hidden" },
): Promise<void> {
  await page.waitForSelector(selector, {
    timeout: options?.timeout ?? 30_000,
    state: options?.state ?? "visible",
  });
}
