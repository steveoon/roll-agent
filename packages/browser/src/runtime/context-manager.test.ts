import assert from "node:assert/strict";
import { test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { BrowserRuntime } from "./browser-runtime.ts";
import type { BrowserInspectablePage } from "./native-cdp-page-client.ts";
import type { BrowserRuntimeMode, Platform } from "../types/index.ts";
import type { SessionStore } from "../session/session-store.ts";
import { BrowserContextManager } from "./context-manager.ts";

type TestPageState = {
  readonly page: Page;
  readonly getCloseCalls: () => number;
  readonly getBringToFrontCalls: () => number;
  readonly getGotoCalls: () => number;
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

function createTestPage(params?: {
  url?: string;
  title?: string;
  hasFocus?: boolean;
  visibilityState?: "visible" | "hidden" | "prerender" | "unloaded";
}): TestPageState {
  let closed = false;
  let closeCalls = 0;
  let bringToFrontCalls = 0;
  let gotoCalls = 0;
  let currentUrl = params?.url ?? "about:blank";
  let assignedContext: BrowserContext | undefined;

  const page = {
    url() {
      return currentUrl;
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
    async goto(url: string) {
      gotoCalls += 1;
      currentUrl = url;
    },
    async evaluate() {
      return {
        hasFocus: params?.hasFocus ?? false,
        visibilityState: params?.visibilityState ?? "hidden",
      };
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
    getGotoCalls: () => gotoCalls,
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
    async getBrowser() {
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

function createInspectablePage(params: {
  targetId: string;
  url: string;
  title?: string;
}): BrowserInspectablePage {
  return {
    targetId: params.targetId,
    type: "page",
    url: params.url,
    title: params.title ?? "",
  };
}

function createNativeRuntime(params: {
  browser: Browser;
  mode: BrowserRuntimeMode;
  inspectablePages: ReadonlyArray<BrowserInspectablePage>;
}): {
  readonly runtime: BrowserRuntime;
  readonly getBrowserCalls: () => number;
  readonly getInspectablePageCalls: () => number;
  readonly getActivatedTargets: () => ReadonlyArray<string>;
} {
  let getBrowserCalls = 0;
  let getInspectablePageCalls = 0;
  const activatedTargets: string[] = [];

  return {
    runtime: {
      mode: params.mode,
      async getBrowser() {
        getBrowserCalls += 1;
        return params.browser;
      },
      async listNativePages() {
        getInspectablePageCalls += 1;
        return params.inspectablePages;
      },
      async activateNativePage(targetId: string) {
        activatedTargets.push(targetId);
      },
      prefersExistingContext() {
        return true;
      },
      allowsNewContext() {
        return params.mode === "remote-cdp";
      },
      shouldRestoreSessionSnapshot() {
        return params.mode === "remote-cdp";
      },
    } as unknown as BrowserRuntime,
    getBrowserCalls: () => getBrowserCalls,
    getInspectablePageCalls: () => getInspectablePageCalls,
    getActivatedTargets: () => activatedTargets,
  };
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

test("useTrackedPage binds a matching site tab to the platform", async () => {
  const otherPage = createTestPage({ url: "https://www.baidu.com" });
  const zhipinPage = createTestPage({ url: "https://www.zhipin.com/web/chat/index" });
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

  const selected = await manager.useTrackedPage("zhipin", (page) =>
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
  assert.equal(ownedContext.getAddInitScriptCalls(), 1);
  assert.equal(sessionStore.getLoadCookiesCalls(), 1);
  assert.equal(sessionStore.getLoadLocalStorageCalls(), 1);

  await manager.closeAll();
  assert.equal(ownedContext.getCloseCalls(), 1);
});

test("listPages assigns stable page ids and selectPage rebinds the platform page", async () => {
  const baiduPage = createTestPage({ url: "https://www.baidu.com", title: "百度" });
  const zhipinPage = createTestPage({
    url: "https://www.zhipin.com/web/chat/index",
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
  const pages = await manager.listAttachedPages();
  const zhipinPageId = manager.getPageId(zhipinPage.page);

  assert.equal(pages.length, 2);
  assert.equal(manager.getPageId(zhipinPage.page), zhipinPageId);

  const selected = await manager.selectAttachedPage("zhipin", zhipinPageId);

  assert.equal(selected, zhipinPage.page);
  assert.equal(manager.getBoundPlatformForPage(zhipinPage.page), "zhipin");
  assert.equal(manager.isSelectedPageForPlatform(zhipinPage.page), true);
  assert.equal(zhipinPage.getBringToFrontCalls(), 1);
});

test("listNativePages uses native CDP metadata without attaching Playwright", async () => {
  const browser = createTestBrowser({
    existingContexts: [],
  });
  const runtime = createNativeRuntime({
    browser: browser.browser,
    mode: "managed-cdp",
    inspectablePages: [
      createInspectablePage({
        targetId: "target-zhipin",
        url: "https://www.zhipin.com/web/chat/index",
        title: "BOSS直聘",
      }),
    ],
  });
  const sessionStore = createSessionStore();
  const manager = new BrowserContextManager(runtime.runtime, sessionStore.store);

  const pages = await manager.listNativePages();

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.targetId, "target-zhipin");
  assert.equal(runtime.getInspectablePageCalls(), 1);
  assert.equal(runtime.getBrowserCalls(), 0);
});

test("selectNativePage activates native target and records selection metadata", async () => {
  const browser = createTestBrowser({
    existingContexts: [],
  });
  const runtime = createNativeRuntime({
    browser: browser.browser,
    mode: "managed-cdp",
    inspectablePages: [
      createInspectablePage({
        targetId: "target-zhipin",
        url: "https://www.zhipin.com/web/chat/index",
        title: "BOSS直聘",
      }),
    ],
  });
  const sessionStore = createSessionStore();
  const manager = new BrowserContextManager(runtime.runtime, sessionStore.store);

  const page = await manager.selectNativePage("zhipin", "target-zhipin");

  assert.equal(page.targetId, "target-zhipin");
  assert.deepEqual(runtime.getActivatedTargets(), ["target-zhipin"]);
  assert.equal(manager.getBoundPlatformForNativePage("target-zhipin"), "zhipin");
  assert.equal(manager.isNativePageSelected("target-zhipin"), true);
  assert.equal(manager.getCurrentUrl("zhipin"), "https://www.zhipin.com/web/chat/index");
  assert.equal(runtime.getBrowserCalls(), 0);
});

test("getPage prefers the natively selected platform tab after later Playwright attach", async () => {
  const otherBossPage = createTestPage({
    url: "https://www.zhipin.com/web/chat/index?conversation=other",
    visibilityState: "hidden",
  });
  const selectedBossPage = createTestPage({
    url: "https://www.zhipin.com/web/chat/index?conversation=selected",
    hasFocus: true,
    visibilityState: "visible",
  });
  const attachedContext = createTestContext([otherBossPage.page, selectedBossPage.page]);
  const browser = createTestBrowser({
    existingContexts: [attachedContext.context],
  });
  const runtime = createNativeRuntime({
    browser: browser.browser,
    mode: "managed-cdp",
    inspectablePages: [
      createInspectablePage({
        targetId: "target-selected",
        url: "https://www.zhipin.com/web/chat/index",
        title: "BOSS直聘",
      }),
    ],
  });
  const sessionStore = createSessionStore();
  const manager = new BrowserContextManager(runtime.runtime, sessionStore.store);

  await manager.selectNativePage("zhipin", "target-selected");
  const page = await manager.getPage("zhipin");

  assert.equal(page, selectedBossPage.page);
  assert.equal(manager.getPageId(page), "target-selected");
  assert.equal(runtime.getBrowserCalls(), 1);
  assert.equal(attachedContext.getNewPageCalls(), 0);
});

test("getActivePage prefers the focused tab", async () => {
  const hiddenPage = createTestPage({
    url: "https://www.baidu.com",
    visibilityState: "hidden",
  });
  const focusedPage = createTestPage({
    url: "https://www.zhipin.com/web/chat/index",
    hasFocus: true,
    visibilityState: "visible",
  });
  const attachedContext = createTestContext([hiddenPage.page, focusedPage.page]);
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

  const page = await manager.getActivePage();

  assert.equal(page, focusedPage.page);
});

test("getActivePage falls back to a visible tab when no tab has focus", async () => {
  const hiddenPage = createTestPage({
    url: "https://www.baidu.com",
    visibilityState: "hidden",
  });
  const visiblePage = createTestPage({
    url: "https://www.zhipin.com/web/chat/index",
    visibilityState: "visible",
  });
  const attachedContext = createTestContext([hiddenPage.page, visiblePage.page]);
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

  const page = await manager.getActivePage();

  assert.equal(page, visiblePage.page);
});

test("getActivePage falls back to the sole page when activity cannot be inferred", async () => {
  const onlyPage = createTestPage({
    url: "https://www.baidu.com",
    visibilityState: "hidden",
  });
  const attachedContext = createTestContext([onlyPage.page]);
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

  const page = await manager.getActivePage();

  assert.equal(page, onlyPage.page);
});

test("rebinding a page to another platform clears the previous platform selection", async () => {
  const sharedPage = createTestPage({
    url: "https://www.zhipin.com/web/chat/index",
    visibilityState: "visible",
  });
  const attachedContext = createTestContext([sharedPage.page]);
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
  const rebound = await manager.selectAttachedPage("yupao", manager.getPageId(sharedPage.page));

  assert.equal(rebound, sharedPage.page);
  assert.equal(manager.getBoundPlatformForPage(sharedPage.page), "yupao");
  assert.equal(manager.getCurrentUrl("zhipin"), undefined);
});
