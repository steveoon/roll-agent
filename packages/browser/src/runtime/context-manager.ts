import type { BrowserContext, Cookie, Page } from "playwright-core";
import type { Platform } from "../types/index.ts";
import type { BrowserRuntime } from "./browser-runtime.ts";
import type { SessionStore } from "../session/session-store.ts";
import { installLocalStorageSnapshot } from "../session/session-state.ts";

type ManagedContext = {
  readonly context: BrowserContext;
  readonly owned: boolean;
};

type ManagedPage = {
  readonly page: Page;
  readonly owned: boolean;
};

function isContextAssigned(
  managedContexts: ReadonlyMap<Platform, ManagedContext>,
  context: BrowserContext,
): boolean {
  return [...managedContexts.values()].some((entry) => entry.context === context);
}

function isPageAssigned(managedPages: ReadonlyMap<Platform, ManagedPage>, page: Page): boolean {
  return [...managedPages.values()].some((entry) => entry.page === page);
}

/**
 * BrowserContext / Page manager.
 *
 * - managed-cdp / existing-session: 优先复用浏览器已有 context 与 page
 * - remote-cdp: 优先复用已有 context，必要时退回 newContext()
 * - SessionStore 仅在 remote-cdp 这类无 profile 主真相的模式下作为恢复兜底
 */
export class BrowserContextManager {
  private readonly contexts = new Map<Platform, ManagedContext>();
  private readonly pages = new Map<Platform, ManagedPage>();
  private readonly runtime: BrowserRuntime;
  private readonly sessionStore: SessionStore;

  constructor(runtime: BrowserRuntime, sessionStore: SessionStore) {
    this.runtime = runtime;
    this.sessionStore = sessionStore;
  }

  private bindPage(platform: Platform, page: Page, owned: boolean): Page {
    const managedPage = {
      page,
      owned,
    } satisfies ManagedPage;
    this.pages.set(platform, managedPage);
    return page;
  }

  async getOrCreateContext(platform: Platform): Promise<BrowserContext> {
    const existing = this.contexts.get(platform);
    if (existing) return existing.context;

    const browser = this.runtime.getBrowser();

    if (this.runtime.prefersExistingContext()) {
      const connectedContext = browser.contexts()[0];
      if (connectedContext) {
        const managedContext = {
          context: connectedContext,
          owned: false,
        } satisfies ManagedContext;
        this.contexts.set(platform, managedContext);
        return connectedContext;
      }
    }

    if (!this.runtime.allowsNewContext()) {
      throw new Error(
        `Browser runtime mode "${this.runtime.mode}" requires an existing browser context.`,
      );
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    if (this.runtime.shouldRestoreSessionSnapshot()) {
      const savedCookies = await this.sessionStore.loadCookies(platform);
      if (savedCookies && savedCookies.length > 0) {
        try {
          await context.addCookies(savedCookies as Cookie[]);
        } catch {
          // cookies 格式不兼容（如 Playwright 版本变更），跳过恢复
        }
      }

      const savedLocalStorage = await this.sessionStore.loadLocalStorage(platform);
      if (savedLocalStorage && Object.keys(savedLocalStorage).length > 0) {
        try {
          await installLocalStorageSnapshot(context, savedLocalStorage);
        } catch {
          // localStorage 恢复失败时跳过，避免阻断 context 创建
        }
      }
    }

    const managedContext = {
      context,
      owned: true,
    } satisfies ManagedContext;
    this.contexts.set(platform, managedContext);
    return context;
  }

  async getPage(platform: Platform): Promise<Page> {
    const existing = this.pages.get(platform);
    if (existing && !existing.page.isClosed()) {
      return existing.page;
    }
    if (existing?.page.isClosed()) {
      this.pages.delete(platform);
    }

    const context = await this.getOrCreateContext(platform);

    const reusablePage = context.pages().find((page) => !isPageAssigned(this.pages, page));
    if (reusablePage) {
      return this.bindPage(platform, reusablePage, false);
    }

    const page = await context.newPage();
    return this.bindPage(platform, page, true);
  }

  async useExistingPage(
    platform: Platform,
    predicate: (page: Page) => boolean,
  ): Promise<Page | undefined> {
    const existing = this.pages.get(platform);
    if (existing && !existing.page.isClosed() && predicate(existing.page)) {
      return existing.page;
    }

    const context = await this.getOrCreateContext(platform);
    const matchedPage = context.pages().find((page) => !page.isClosed() && predicate(page));
    if (!matchedPage) {
      return undefined;
    }

    return this.bindPage(platform, matchedPage, false);
  }

  hasContext(platform: Platform): boolean {
    return this.contexts.has(platform);
  }

  getPageCount(platform: Platform): number {
    const entry = this.contexts.get(platform);
    return entry ? entry.context.pages().length : 0;
  }

  getCurrentUrl(platform: Platform): string | undefined {
    const entry = this.pages.get(platform);
    if (!entry || entry.page.isClosed()) {
      return undefined;
    }
    return entry.page.url();
  }

  getActivePlatforms(): ReadonlyArray<Platform> {
    return [...this.contexts.keys()];
  }

  async closeContext(platform: Platform): Promise<void> {
    const pageEntry = this.pages.get(platform);
    if (pageEntry) {
      if (pageEntry.owned && !pageEntry.page.isClosed()) {
        await pageEntry.page.close();
      }
      this.pages.delete(platform);
    }

    const contextEntry = this.contexts.get(platform);
    if (!contextEntry) return;

    this.contexts.delete(platform);

    if (!contextEntry.owned) {
      return;
    }

    if (isContextAssigned(this.contexts, contextEntry.context)) {
      return;
    }

    await contextEntry.context.close();
  }

  async closeAll(): Promise<void> {
    const platforms = [...this.contexts.keys()];
    for (const platform of platforms) {
      await this.closeContext(platform);
    }
  }
}
