import type { BrowserContext, Cookie, Page } from "playwright-core";
import type { Platform } from "../types/index.ts";
import type { BrowserRuntime } from "./browser-runtime.ts";
import type { BrowserInspectablePage } from "./native-cdp-page-client.ts";
import type { SessionStore } from "../session/session-store.ts";
import { installLocalStorageSnapshot } from "../session/session-state.ts";

type ManagedContext = {
  readonly context: BrowserContext;
  readonly owned: boolean;
};

type ManagedPage = {
  readonly page: Page;
  readonly owned: boolean;
  readonly pageId: string;
};

type NativePageSelection = {
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
};

type PlatformRuntimeState = {
  context?: ManagedContext;
  page?: ManagedPage;
  nativeSelection?: NativePageSelection;
};

type PageVisibilityState = "visible" | "hidden" | "prerender" | "unloaded";

type PageActivityState = {
  readonly hasFocus: boolean;
  readonly visibilityState: PageVisibilityState;
};

function findManagedContext(
  platformStates: ReadonlyMap<Platform, PlatformRuntimeState>,
  context: BrowserContext,
): ManagedContext | undefined {
  return [...platformStates.values()]
    .map((state) => state.context)
    .find((entry) => entry?.context === context);
}

function isContextAssigned(
  platformStates: ReadonlyMap<Platform, PlatformRuntimeState>,
  context: BrowserContext,
  exceptPlatform?: Platform,
): boolean {
  return [...platformStates.entries()].some(
    ([platform, state]) => platform !== exceptPlatform && state.context?.context === context,
  );
}

function findManagedPage(
  platformStates: ReadonlyMap<Platform, PlatformRuntimeState>,
  page: Page,
): ManagedPage | undefined {
  return [...platformStates.values()]
    .map((state) => state.page)
    .find((entry) => entry?.page === page);
}

function isPageAssigned(
  platformStates: ReadonlyMap<Platform, PlatformRuntimeState>,
  page: Page,
  exceptPlatform?: Platform,
): boolean {
  return [...platformStates.entries()].some(
    ([platform, state]) => platform !== exceptPlatform && state.page?.page === page,
  );
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

function sharesPageOrigin(leftUrl: string, rightUrl: string): boolean {
  try {
    const left = new URL(leftUrl);
    const right = new URL(rightUrl);
    return left.origin === right.origin;
  } catch {
    return false;
  }
}

async function preferActivePage(pages: ReadonlyArray<Page>): Promise<Page | undefined> {
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

  return pageStates.find((entry) => entry.activity.visibilityState === "visible")?.page;
}

/**
 * BrowserContext / Page manager.
 *
 * - 登录前：维护平台 -> native CDP target 选择状态
 * - attach 后：维护平台 -> Playwright context/page 绑定状态
 * - 两条路径最终都汇总到同一份 platform state，避免双轨 Map 分裂
 */
export class BrowserContextManager {
  private readonly platformStates = new Map<Platform, PlatformRuntimeState>();
  private readonly generatedPageIds = new WeakMap<Page, string>();
  private nextGeneratedPageId = 1;
  private readonly runtime: BrowserRuntime;
  private readonly sessionStore: SessionStore;

  constructor(runtime: BrowserRuntime, sessionStore: SessionStore) {
    this.runtime = runtime;
    this.sessionStore = sessionStore;
  }

  private getOrCreateState(platform: Platform): PlatformRuntimeState {
    const existing = this.platformStates.get(platform);
    if (existing) {
      return existing;
    }

    const state = {} satisfies PlatformRuntimeState;
    this.platformStates.set(platform, state);
    return state;
  }

  private pruneState(platform: Platform): void {
    const state = this.platformStates.get(platform);
    if (!state) {
      return;
    }

    if (state.context || state.page || state.nativeSelection) {
      return;
    }

    this.platformStates.delete(platform);
  }

  private getOrAssignGeneratedPageId(page: Page): string {
    const existing = this.generatedPageIds.get(page);
    if (existing !== undefined) {
      return existing;
    }

    const nextId = `page-${this.nextGeneratedPageId}`;
    this.nextGeneratedPageId += 1;
    this.generatedPageIds.set(page, nextId);
    return nextId;
  }

  private bindContext(platform: Platform, context: BrowserContext, owned: boolean): void {
    const state = this.getOrCreateState(platform);
    if (state.context?.context === context) {
      state.context = {
        context,
        owned: state.context.owned || owned,
      };
      return;
    }

    state.context = findManagedContext(this.platformStates, context) ?? {
      context,
      owned,
    };
  }

  private clearSelectionForPlatform(platform: Platform): void {
    const state = this.platformStates.get(platform);
    if (!state) {
      return;
    }

    delete state.page;
    delete state.nativeSelection;
    this.pruneState(platform);
  }

  private clearSelectionsForPage(page: Page, keepPlatform?: Platform): void {
    for (const [platform, state] of this.platformStates.entries()) {
      if (platform === keepPlatform || state.page?.page !== page) {
        continue;
      }

      delete state.page;
      delete state.nativeSelection;
      this.pruneState(platform);
    }
  }

  private bindPage(platform: Platform, page: Page, owned: boolean): Page {
    const state = this.getOrCreateState(platform);
    this.bindContext(platform, page.context(), false);

    const sharedPage = findManagedPage(this.platformStates, page);
    const pageId =
      sharedPage?.pageId ?? state.nativeSelection?.targetId ?? this.getOrAssignGeneratedPageId(page);

    this.clearSelectionsForPage(page, platform);
    state.page = {
      page,
      owned: sharedPage?.owned ?? owned,
      pageId,
    };
    delete state.nativeSelection;
    return page;
  }

  private async findPreferredPageForPlatform(
    platform: Platform,
    pages: ReadonlyArray<Page>,
  ): Promise<Page | undefined> {
    const selection = this.platformStates.get(platform)?.nativeSelection;
    if (!selection) {
      return undefined;
    }

    const openPages = pages.filter((page) => !page.isClosed());
    const exactUrlMatches = openPages.filter((page) => page.url() === selection.url);
    if (exactUrlMatches.length === 1) {
      return exactUrlMatches[0];
    }

    const exactUrlActive = await preferActivePage(exactUrlMatches);
    if (exactUrlActive) {
      return exactUrlActive;
    }

    const sameOriginMatches = openPages.filter((page) => sharesPageOrigin(page.url(), selection.url));
    if (sameOriginMatches.length === 1) {
      return sameOriginMatches[0];
    }

    const sameOriginActive = await preferActivePage(sameOriginMatches);
    if (sameOriginActive) {
      return sameOriginActive;
    }

    if (selection.title.length === 0) {
      return undefined;
    }

    const titleMatches = (
      await Promise.all(
        openPages.map(async (page) => ({
          page,
          title: await page.title().catch(() => ""),
        })),
      )
    )
      .filter((entry) => entry.title === selection.title)
      .map((entry) => entry.page);

    if (titleMatches.length === 1) {
      return titleMatches[0];
    }

    return await preferActivePage(titleMatches);
  }

  async getOrCreateContext(platform: Platform): Promise<BrowserContext> {
    const existingContext = this.platformStates.get(platform)?.context;
    if (existingContext) {
      return existingContext.context;
    }

    const browser = await this.runtime.getBrowser();

    if (this.runtime.prefersExistingContext()) {
      const connectedContext = browser.contexts()[0];
      if (connectedContext) {
        this.bindContext(platform, connectedContext, false);
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

    this.bindContext(platform, context, true);
    return context;
  }

  async getPage(platform: Platform): Promise<Page> {
    const existingPage = this.platformStates.get(platform)?.page;
    if (existingPage && !existingPage.page.isClosed()) {
      return existingPage.page;
    }
    if (existingPage?.page.isClosed()) {
      const state = this.platformStates.get(platform);
      if (state) {
        delete state.page;
        this.pruneState(platform);
      }
    }

    const context = await this.getOrCreateContext(platform);
    const preferredPage = await this.findPreferredPageForPlatform(platform, context.pages());
    if (preferredPage) {
      return this.bindPage(platform, preferredPage, false);
    }

    const reusablePage = context
      .pages()
      .find((page) => !isPageAssigned(this.platformStates, page));
    if (reusablePage) {
      return this.bindPage(platform, reusablePage, false);
    }

    const page = await context.newPage();
    return this.bindPage(platform, page, true);
  }

  async listAttachedPages(): Promise<ReadonlyArray<Page>> {
    const browser = await this.runtime.getBrowser();
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.isClosed());

    for (const page of pages) {
      this.getOrAssignGeneratedPageId(page);
    }

    return pages;
  }

  async listNativePages(): Promise<ReadonlyArray<BrowserInspectablePage>> {
    return await this.runtime.listNativePages();
  }

  getPageId(page: Page): string {
    return findManagedPage(this.platformStates, page)?.pageId ?? this.getOrAssignGeneratedPageId(page);
  }

  clearBindingForPage(page: Page): void {
    const entry = [...this.platformStates.entries()].find(([, state]) => state.page?.page === page);
    if (!entry) {
      return;
    }

    this.clearSelectionForPlatform(entry[0]);
  }

  async getActivePage(): Promise<Page | undefined> {
    const pages = await this.listAttachedPages();
    if (pages.length === 0) {
      return undefined;
    }

    const focusedPage = await preferActivePage(pages);
    if (focusedPage) {
      return focusedPage;
    }

    return pages.length === 1 ? pages[0] : undefined;
  }

  getBoundPlatformForPage(page: Page): Platform | undefined {
    return [...this.platformStates.entries()].find(([, state]) => state.page?.page === page)?.[0];
  }

  isSelectedPageForPlatform(page: Page): boolean {
    return [...this.platformStates.values()].some((state) => state.page?.page === page);
  }

  getBoundPlatformForNativePage(targetId: string): Platform | undefined {
    return [...this.platformStates.entries()].find(([, state]) => state.nativeSelection?.targetId === targetId)?.[0];
  }

  isNativePageSelected(targetId: string): boolean {
    return this.getBoundPlatformForNativePage(targetId) !== undefined;
  }

  rememberNativePageSelection(platform: Platform, page: BrowserInspectablePage): void {
    const state = this.getOrCreateState(platform);
    delete state.page;
    state.nativeSelection = {
      targetId: page.targetId,
      url: page.url,
      title: page.title,
    };
  }

  async selectNativePage(platform: Platform, targetId: string): Promise<BrowserInspectablePage> {
    const page = (await this.runtime.listNativePages()).find((candidate) => candidate.targetId === targetId);
    if (!page) {
      throw new Error(`Page "${targetId}" not found.`);
    }

    await this.runtime.activateNativePage(page.targetId);
    this.rememberNativePageSelection(platform, page);
    return page;
  }

  async selectAttachedPage(platform: Platform, pageId: string): Promise<Page> {
    const page = (await this.listAttachedPages()).find((candidate) => this.getPageId(candidate) === pageId);
    if (!page) {
      throw new Error(`Page "${pageId}" not found.`);
    }

    this.bindPage(platform, page, false);
    await page.bringToFront().catch(() => {});
    return page;
  }

  async useTrackedPage(
    platform: Platform,
    predicate: (page: Page) => boolean,
  ): Promise<Page | undefined> {
    const existingPage = this.platformStates.get(platform)?.page;
    if (existingPage && !existingPage.page.isClosed() && predicate(existingPage.page)) {
      return existingPage.page;
    }

    const context = await this.getOrCreateContext(platform);
    const preferredPage = await this.findPreferredPageForPlatform(
      platform,
      context.pages().filter((page) => predicate(page)),
    );
    if (preferredPage) {
      return this.bindPage(platform, preferredPage, false);
    }

    const matchedPage = context.pages().find((page) => !page.isClosed() && predicate(page));
    if (!matchedPage) {
      return undefined;
    }

    return this.bindPage(platform, matchedPage, false);
  }

  hasContext(platform: Platform): boolean {
    return this.platformStates.get(platform)?.context !== undefined;
  }

  getPageCount(platform: Platform): number {
    const state = this.platformStates.get(platform);
    if (state?.context) {
      return state.context.context.pages().length;
    }
    return state?.nativeSelection ? 1 : 0;
  }

  getCurrentUrl(platform: Platform): string | undefined {
    const state = this.platformStates.get(platform);
    if (!state) {
      return undefined;
    }

    if (state.page && !state.page.page.isClosed()) {
      return state.page.page.url();
    }

    return state.nativeSelection?.url;
  }

  getActivePlatforms(): ReadonlyArray<Platform> {
    return [...this.platformStates.keys()];
  }

  async closeContext(platform: Platform): Promise<void> {
    const state = this.platformStates.get(platform);
    if (!state) {
      return;
    }

    this.platformStates.delete(platform);

    if (state.page?.owned && !state.page.page.isClosed()) {
      await state.page.page.close();
    }

    if (!state.context?.owned) {
      return;
    }

    if (isContextAssigned(this.platformStates, state.context.context, platform)) {
      return;
    }

    await state.context.context.close();
  }

  async closeAll(): Promise<void> {
    const platforms = [...this.platformStates.keys()];
    for (const platform of platforms) {
      await this.closeContext(platform);
    }
  }
}
