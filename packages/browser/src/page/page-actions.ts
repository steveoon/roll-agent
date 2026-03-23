import type { Page } from "playwright-core";
import type { PageSnapshot } from "../types/index.ts";

/** 获取当前页面快照（URL + title + HTML） */
export async function snapshot(page: Page): Promise<PageSnapshot> {
  const [url, title, html] = await Promise.all([
    Promise.resolve(page.url()),
    page.title(),
    page.content(),
  ]);
  return { url, title, html };
}

/** 点击页面元素 */
export async function clickElement(page: Page, selector: string): Promise<void> {
  await page.click(selector);
}

/** 在输入框中输入文本（先清空再输入） */
export async function typeText(page: Page, selector: string, text: string): Promise<void> {
  await page.fill(selector, text);
}

/** 导航到指定 URL */
export async function navigateTo(
  page: Page,
  url: string,
  options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" },
): Promise<void> {
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
