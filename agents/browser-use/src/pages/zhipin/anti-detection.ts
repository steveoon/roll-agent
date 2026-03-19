import type { Page } from "@roll-agent/browser";

/** 随机延迟 */
export async function randomDelay(page: Page, min = 300, max = 800): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min)) + min;
  await page.waitForTimeout(ms);
}

/** 模拟人类操作延迟（概率分布） */
export async function humanDelay(page: Page): Promise<void> {
  const rand = Math.random();
  let ms: number;
  if (rand < 0.5) {
    ms = 800 + Math.random() * 1200;
  } else if (rand < 0.8) {
    ms = 500 + Math.random() * 300;
  } else if (rand < 0.95) {
    ms = 2000 + Math.random() * 2000;
  } else {
    ms = 4000 + Math.random() * 2000;
  }
  await page.waitForTimeout(Math.floor(ms));
}

/** 模拟随机滚动 */
export async function performRandomScroll(
  page: Page,
  options?: { minDistance?: number; maxDistance?: number; direction?: "up" | "down" | "both" },
): Promise<void> {
  const min = options?.minDistance ?? 50;
  const max = options?.maxDistance ?? 200;
  const direction = options?.direction ?? "both";
  const distance = Math.floor(Math.random() * (max - min)) + min;
  const sign = direction === "up" ? -1 : direction === "down" ? 1 : Math.random() > 0.5 ? 1 : -1;

  await page.evaluate((scrollY: number) => {
    window.scrollBy({ top: scrollY, behavior: "smooth" });
  }, distance * sign);

  await randomDelay(page, 200, 500);
}

/** 初始浏览模式滚动（模拟用户进入页面时的行为） */
export async function performInitialScrollPattern(page: Page): Promise<void> {
  if (Math.random() < 0.8) {
    const distance = 100 + Math.floor(Math.random() * 100);
    await page.evaluate((d: number) => {
      window.scrollBy({ top: d, behavior: "smooth" });
    }, distance);
    await humanDelay(page);
  }

  if (Math.random() < 0.5) {
    const distance = (50 + Math.floor(Math.random() * 100)) * (Math.random() > 0.5 ? 1 : -1);
    await page.evaluate((d: number) => {
      window.scrollBy({ top: d, behavior: "smooth" });
    }, distance);
  }
}

/** 生成打字延迟（模拟键盘输入速度） */
export function generateTypingDelay(): number {
  let base = 60 + Math.random() * 60;
  if (Math.random() < 0.1) base += 200 + Math.random() * 100;
  if (Math.random() < 0.05) base = 30 + Math.random() * 30;
  return Math.floor(base);
}

/** 概率性触发随机行为 */
export function shouldAddRandomBehavior(probability = 0.3): boolean {
  return Math.random() < probability;
}
