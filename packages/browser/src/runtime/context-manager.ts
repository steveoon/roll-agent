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

type PageVisibilityState = "visible" | "hidden" | "prerender" | "unloaded";

type PageActivityState = {
  readonly hasFocus: boolean;
  readonly visibilityState: PageVisibilityState;
};

function findManagedContext(
  managedContexts: ReadonlyMap<Platform, ManagedContext>,
  context: BrowserContext,
): ManagedContext | undefined {
  return [...managedContexts.values()].find((entry) => entry.context === context);
}

function isContextAssigned(
  managedContexts: ReadonlyMap<Platform, ManagedContext>,
  context: BrowserContext,
): boolean {
  return [...managedContexts.values()].some((entry) => entry.context === context);
}

function findManagedPage(
  managedPages: ReadonlyMap<Platform, ManagedPage>,
  page: Page,
): ManagedPage | undefined {
  return [...managedPages.values()].find((entry) => entry.page === page);
}

function isPageAssigned(managedPages: ReadonlyMap<Platform, ManagedPage>, page: Page): boolean {
  return [...managedPages.values()].some((entry) => entry.page === page);
}

async function readPageActivityState(page: Page): Promise<PageActivityState> {
  try {
    return await page.evaluate(() => ({
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    }));
  } catch {
    return {
      hasFocus: false,
      visibilityState: "hidden",
    };
  }
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
  private readonly pageIds = new WeakMap<Page, string>();
  private nextPageId = 1;
  private readonly runtime: BrowserRuntime;
  private readonly sessionStore: SessionStore;

  constructor(runtime: BrowserRuntime, sessionStore: SessionStore) {
    this.runtime = runtime;
    this.sessionStore = sessionStore;
  }

  private getOrAssignPageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing !== undefined) {
      return existing;
    }

    const nextId = `page-${this.nextPageId}`;
    this.nextPageId += 1;
    this.pageIds.set(page, nextId);
    return nextId;
  }

  private bindContext(platform: Platform, context: BrowserContext): void {
    const existing = this.contexts.get(platform);
    if (existing?.context === context) {
      return;
    }

    const shared = findManagedContext(this.contexts, context);
    this.contexts.set(
      platform,
      shared ?? {
        context,
        owned: false,
      },
    );
  }

  private clearPageBindings(page: Page): void {
    for (const [platform, entry] of this.pages.entries()) {
      if (entry.page === page) {
        this.pages.delete(platform);
      }
    }
  }

  private bindPage(platform: Platform, page: Page, owned: boolean): Page {
    this.bindContext(platform, page.context());
    this.getOrAssignPageId(page);

    const shared = findManagedPage(this.pages, page);
    const managedPage = {
      page,
      owned: shared?.owned ?? owned,
    } satisfies ManagedPage;
    this.clearPageBindings(page);
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

  listPages(): ReadonlyArray<Page> {
    const browser = this.runtime.getBrowser();
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.isClosed());

    for (const page of pages) {
      this.getOrAssignPageId(page);
    }

    return pages;
  }

  getPageId(page: Page): string {
    return this.getOrAssignPageId(page);
  }

  clearBindingForPage(page: Page): void {
    this.clearPageBindings(page);
  }

  async getActivePage(): Promise<Page | undefined> {
    const pages = this.listPages();
    if (pages.length === 0) {
      return undefined;
    }

    const pageStates = await Promise.all(
      pages.map(async (page) => ({
        page,
        activity: await readPageActivityState(page),
      })),
    );

    const focusedPage = pageStates.find((entry) => entry.activity.hasFocus)?.page;
    if (focusedPage) {
      return focusedPage;
    }

    const visiblePage = pageStates.find(
      (entry) => entry.activity.visibilityState === "visible",
    )?.page;
    if (visiblePage) {
      return visiblePage;
    }

    return pages.length === 1 ? pages[0] : undefined;
  }

  getBoundPlatformForPage(page: Page): Platform | undefined {
    return [...this.pages.entries()].find(([, entry]) => entry.page === page)?.[0];
  }

  isSelectedPageForPlatform(page: Page): boolean {
    return [...this.pages.values()].some((entry) => entry.page === page);
  }

  async selectPage(platform: Platform, pageId: string): Promise<Page> {
    const page = this.listPages().find((candidate) => this.getPageId(candidate) === pageId);
    if (!page) {
      throw new Error(`Page "${pageId}" not found.`);
    }

    this.bindPage(platform, page, false);
    await page.bringToFront().catch(() => {});
    return page;
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
