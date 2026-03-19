import assert from "node:assert/strict";
import { test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { BrowserRuntime } from "./browser-runtime.ts";
import type { BrowserRuntimeMode, Platform } from "../types/index.ts";
import type { SessionStore } from "../session/session-store.ts";
import { BrowserContextManager } from "./context-manager.ts";

type TestPageState = {
  readonly page: Page;
  readonly getCloseCalls: () => number;
  readonly getBringToFrontCalls: () => number;
  readonly setContext: (context: BrowserContext) => void;
};

type TestContextState = {
  readonly context: BrowserContext;
  readonly getNewPageCalls: () => number;
  readonly getAddInitScriptCalls: () => number;
  readonly getAddCookiesCalls: () => number;
  readonly getCloseCalls: () => number;
};

type TestBrowserState = {
  readonly browser: Browser;
  readonly getNewContextCalls: () => number;
};

type TestSessionStoreState = {
  readonly store: SessionStore;
  readonly getLoadCookiesCalls: () => number;
  readonly getLoadLocalStorageCalls: () => number;
};

function createTestPage(params?: { url?: string; title?: string }): TestPageState {
  let closed = false;
  let closeCalls = 0;
  let bringToFrontCalls = 0;
  let assignedContext: BrowserContext | undefined;

  const page = {
    url() {
      return params?.url ?? "about:blank";
    },
    async title() {
      return params?.title ?? "";
    },
    context() {
      if (!assignedContext) {
        throw new Error("Page context not assigned in test.");
      }
      return assignedContext;
    },
    async bringToFront() {
      bringToFrontCalls += 1;
    },
    isClosed() {
      return closed;
    },
    async close() {
      closeCalls += 1;
      closed = true;
    },
  } as unknown as Page;

  const mutablePage = page as Page & { setContext?: (context: BrowserContext) => void };
  mutablePage.setContext = (context) => {
    assignedContext = context;
  };

  return {
    page,
    getCloseCalls: () => closeCalls,
    getBringToFrontCalls: () => bringToFrontCalls,
    setContext: (context) => {
      mutablePage.setContext?.(context);
    },
  };
}

function createTestContext(initialPages: ReadonlyArray<Page> = []): TestContextState {
  let pages = [...initialPages];
  let newPageCalls = 0;
  let addInitScriptCalls = 0;
  let addCookiesCalls = 0;
  let closeCalls = 0;

  const context = {
    pages() {
      return pages;
    },
    async newPage() {
      newPageCalls += 1;
      const nextPageState = createTestPage();
      nextPageState.setContext(context as BrowserContext);
      const nextPage = nextPageState.page;
      pages = [...pages, nextPage];
      return nextPage;
    },
    async addInitScript() {
      addInitScriptCalls += 1;
    },
    async addCookies() {
      addCookiesCalls += 1;
    },
    async close() {
      closeCalls += 1;
    },
  } as unknown as BrowserContext;

  for (const page of pages) {
    const testPage = page as Page & { setContext?: (context: BrowserContext) => void };
    testPage.setContext?.(context);
  }

  return {
    context,
    getNewPageCalls: () => newPageCalls,
    getAddInitScriptCalls: () => addInitScriptCalls,
    getAddCookiesCalls: () => addCookiesCalls,
    getCloseCalls: () => closeCalls,
  };
}

function createTestBrowser(params: {
  existingContexts?: ReadonlyArray<BrowserContext>;
  newContextFactory?: () => BrowserContext;
}): TestBrowserState {
  let newContextCalls = 0;
  const existingContexts = [...(params.existingContexts ?? [])];

  const browser = {
    contexts() {
      return existingContexts;
    },
    async newContext() {
      newContextCalls += 1;
      const nextContext = params.newContextFactory?.();
      if (!nextContext) {
        throw new Error("Unexpected newContext() call in test.");
      }
      return nextContext;
    },
  } as unknown as Browser;

  return {
    browser,
    getNewContextCalls: () => newContextCalls,
  };
}

function createRuntime(params: {
  browser: Browser;
  mode: BrowserRuntimeMode;
  allowsNewContext?: boolean;
  shouldRestoreSessionSnapshot?: boolean;
}): BrowserRuntime {
  return {
    mode: params.mode,
    getBrowser() {
      return params.browser;
    },
    prefersExistingContext() {
      return true;
    },
    allowsNewContext() {
      return params.allowsNewContext ?? params.mode === "remote-cdp";
    },
    shouldRestoreSessionSnapshot() {
      return params.shouldRestoreSessionSnapshot ?? params.mode === "remote-cdp";
    },
  } as unknown as BrowserRuntime;
}

function createSessionStore(params?: {
  cookies?: ReadonlyArray<unknown>;
  localStorage?: Record<string, string>;
}): TestSessionStoreState {
  let loadCookiesCalls = 0;
  let loadLocalStorageCalls = 0;

  const store = {
    async loadCookies(_platform: Platform) {
      loadCookiesCalls += 1;
      return params?.cookies;
    },
    async loadLocalStorage(_platform: Platform) {
      loadLocalStorageCalls += 1;
      return params?.localStorage;
    },
  } as unknown as SessionStore;

  return {
    store,
    getLoadCookiesCalls: () => loadCookiesCalls,
    getLoadLocalStorageCalls: () => loadLocalStorageCalls,
  };
}

test("existing-session reuses an attached browser context and page", async () => {
  const firstPage = createTestPage();
  const attachedContext = createTestContext([firstPage.page]);
  const browser = createTestBrowser({
    existingContexts: [attachedContext.context],
  });
  const runtime = createRuntime({
    browser: browser.browser,
    mode: "existing-session",
  });
  const sessionStore = createSessionStore();
  const manager = new BrowserContextManager(runtime, sessionStore.store);

  const page = await manager.getPage("zhipin");

  assert.equal(page, firstPage.page);
  assert.equal(browser.getNewContextCalls(), 0);
  assert.equal(attachedContext.getNewPageCalls(), 0);
  assert.equal(attachedContext.getAddInitScriptCalls(), 0);
  assert.equal(attachedContext.getAddCookiesCalls(), 0);
  assert.equal(sessionStore.getLoadCookiesCalls(), 0);
  assert.equal(sessionStore.getLoadLocalStorageCalls(), 0);

  await manager.closeAll();
  assert.equal(firstPage.getCloseCalls(), 0);
  assert.equal(attachedContext.getCloseCalls(), 0);
});

test("shared attached context creates a dedicated tab for the second platform", async () => {
  const firstPage = createTestPage();
  const attachedContext = createTestContext([firstPage.page]);
  const browser = createTestBrowser({
    existingContexts: [attachedContext.context],
  });
  const runtime = createRuntime({
    browser: browser.browser,
    mode: "managed-cdp",
    allowsNewContext: false,
  });
  const sessionStore = createSessionStore();
  const manager = new BrowserContextManager(runtime, sessionStore.store);

  const zhipinPage = await manager.getPage("zhipin");
  const yupaoPage = await manager.getPage("yupao");

  assert.equal(zhipinPage, firstPage.page);
  assert.notEqual(yupaoPage, firstPage.page);
  assert.equal(attachedContext.getNewPageCalls(), 1);
});

test("useExistingPage binds a matching site tab to the platform", async () => {
  const otherPage = createTestPage({ url: "https://www.baidu.com" });
  const zhipinPage = createTestPage({ url: "https://www.zhipin.com/web/geek/chat" });
  const attachedContext = createTestContext([otherPage.page, zhipinPage.page]);
  const browser = createTestBrowser({
    existingContexts: [attachedContext.context],
  });
  const runtime = createRuntime({
    browser: browser.browser,
    mode: "managed-cdp",
    allowsNewContext: false,
  });
  const sessionStore = createSessionStore();
  const manager = new BrowserContextManager(runtime, sessionStore.store);

  const selected = await manager.useExistingPage("zhipin", (page) =>
    page.url().includes("zhipin.com"),
  );

  assert.equal(selected, zhipinPage.page);
  const reused = await manager.getPage("zhipin");
  assert.equal(reused, zhipinPage.page);
  assert.equal(attachedContext.getNewPageCalls(), 0);
});

test("remote-cdp falls back to newContext and restores sidecar session snapshots", async () => {
  const ownedContext = createTestContext();
  const browser = createTestBrowser({
    existingContexts: [],
    newContextFactory: () => ownedContext.context,
  });
  const runtime = createRuntime({
    browser: browser.browser,
    mode: "remote-cdp",
  });
  const sessionStore = createSessionStore({
    cookies: [{ name: "sid", value: "cookie", domain: ".example.com", path: "/" }],
    localStorage: { token: "secret" },
  });
  const manager = new BrowserContextManager(runtime, sessionStore.store);

  const page = await manager.getPage("zhipin");

  assert.ok(page);
  assert.equal(browser.getNewContextCalls(), 1);
  assert.equal(ownedContext.getAddCookiesCalls(), 1);
  assert.equal(ownedContext.getAddInitScriptCalls(), 2);
  assert.equal(sessionStore.getLoadCookiesCalls(), 1);
  assert.equal(sessionStore.getLoadLocalStorageCalls(), 1);

  await manager.closeAll();
  assert.equal(ownedContext.getCloseCalls(), 1);
});

test("listPages assigns stable page ids and selectPage rebinds the platform page", async () => {
  const baiduPage = createTestPage({ url: "https://www.baidu.com", title: "百度" });
  const zhipinPage = createTestPage({
    url: "https://www.zhipin.com/web/geek/chat",
    title: "BOSS直聘",
  });
  const attachedContext = createTestContext([baiduPage.page, zhipinPage.page]);
  const browser = createTestBrowser({
    existingContexts: [attachedContext.context],
  });
  const runtime = createRuntime({
    browser: browser.browser,
    mode: "managed-cdp",
    allowsNewContext: false,
  });
  const sessionStore = createSessionStore();
  const manager = new BrowserContextManager(runtime, sessionStore.store);

  await manager.getPage("zhipin");
  const pages = manager.listPages();
  const zhipinPageId = manager.getPageId(zhipinPage.page);

  assert.equal(pages.length, 2);
  assert.equal(manager.getPageId(zhipinPage.page), zhipinPageId);

  const selected = await manager.selectPage("zhipin", zhipinPageId);

  assert.equal(selected, zhipinPage.page);
  assert.equal(manager.getBoundPlatformForPage(zhipinPage.page), "zhipin");
  assert.equal(manager.isSelectedPageForPlatform(zhipinPage.page), true);
  assert.equal(zhipinPage.getBringToFrontCalls(), 1);
});
