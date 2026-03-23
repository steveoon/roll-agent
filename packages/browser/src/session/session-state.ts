import type { BrowserContext, Page } from "playwright-core";

/**
 * 读取当前页面的 localStorage 快照。
 */
export async function captureLocalStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const snapshot: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null) continue;
      const value = window.localStorage.getItem(key);
      if (value !== null) {
        snapshot[key] = value;
      }
    }
    return snapshot;
  });
}

/**
 * 在 context 中预置 localStorage 恢复脚本。
 *
 * 该脚本会在后续页面脚本执行前运行，适合恢复登录态等平台级状态。
 */
export async function installLocalStorageSnapshot(
  context: BrowserContext,
  snapshot: Readonly<Record<string, string>>,
): Promise<void> {
  const entries = Object.entries(snapshot);
  if (entries.length === 0) return;

  await context.addInitScript((storedEntries: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of storedEntries) {
      window.localStorage.setItem(key, value);
    }
  }, entries);
}
