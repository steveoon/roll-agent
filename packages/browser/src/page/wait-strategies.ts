import type { Page } from "playwright-core";

/** 等待网络空闲（无新请求超过指定时间） */
export async function waitForNetworkIdle(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await page.waitForLoadState("networkidle", {
    timeout: options?.timeout ?? 30_000,
  });
}

/** 等待选择器可见 */
export async function waitForSelectorVisible(
  page: Page,
  selector: string,
  options?: { timeout?: number },
): Promise<void> {
  await page.waitForSelector(selector, {
    state: "visible",
    timeout: options?.timeout ?? 30_000,
  });
}

/** 等待自定义条件成立（轮询） */
export async function waitForCondition(
  page: Page,
  predicate: () => boolean | Promise<boolean>,
  options?: { timeout?: number; pollInterval?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  const pollInterval = options?.pollInterval ?? 500;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.waitForTimeout(pollInterval);
  }

  throw new Error(`waitForCondition timed out after ${timeout}ms`);
}
