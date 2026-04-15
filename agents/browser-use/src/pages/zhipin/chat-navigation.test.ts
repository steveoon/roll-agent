import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContextManager, Page } from "@roll-agent/browser";
import { ensureChatListLoaded, ensureChatOpen, selectChatCandidate } from "./chat-navigation.ts";

const ZHIPIN_CHAT_URL = "https://www.zhipin.com/web/geek/chat";

const candidates = [
  {
    name: "鲁伟",
    index: 0,
    hasUnread: true,
    unreadCount: 1,
    lastMessageTime: "10:00",
    messagePreview: "您好",
  },
  {
    name: "鲁杰",
    index: 1,
    hasUnread: false,
    unreadCount: 0,
    lastMessageTime: "09:30",
    messagePreview: "收到",
  },
  {
    name: "张三丰",
    index: 2,
    hasUnread: false,
    unreadCount: 0,
    lastMessageTime: "09:00",
    messagePreview: "你好",
  },
] as const;

type TestPageOptions = {
  url?: string;
  title?: string;
  chatListLoaded?: boolean;
  clickMessageEntryWorks?: boolean;
  clickLoadsChatList?: boolean;
  gotoBehavior?: "success" | "err_aborted" | "error";
  gotoResultUrl?: string;
  gotoLoadsChatList?: boolean;
  chatCandidates?: ReadonlyArray<unknown>;
  clickChatItemWorks?: boolean;
};

function createTestPage(options: TestPageOptions = {}) {
  let currentUrl = options.url ?? "about:blank";
  let chatListLoaded = options.chatListLoaded ?? false;
  let gotoCalls = 0;
  let clickMessageEntryCalls = 0;
  let clickChatItemCalls = 0;
  let waitForFunctionCalls = 0;

  const page = {
    url() {
      return currentUrl;
    },
    async title() {
      return options.title ?? "";
    },
    async waitForSelector() {
      if (chatListLoaded) {
        return {};
      }
      throw new Error("selector timeout");
    },
    async goto(url: string) {
      gotoCalls += 1;
      currentUrl = options.gotoResultUrl ?? url;
      chatListLoaded = options.gotoLoadsChatList ?? true;
      if (options.gotoBehavior === "err_aborted") {
        throw new Error("net::ERR_ABORTED");
      }
      if (options.gotoBehavior === "error") {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }
    },
    async evaluate(_fn: unknown, arg?: unknown) {
      if (Array.isArray(arg)) {
        clickMessageEntryCalls += 1;
        if (!options.clickMessageEntryWorks) {
          return false;
        }
        currentUrl = ZHIPIN_CHAT_URL;
        chatListLoaded = options.clickLoadsChatList ?? true;
        return true;
      }

      if (typeof arg === "number") {
        clickChatItemCalls += 1;
        return options.clickChatItemWorks ?? true;
      }

      return [...(options.chatCandidates ?? [])];
    },
    async waitForFunction() {
      waitForFunctionCalls += 1;
      return {};
    },
    async bringToFront() {
      return;
    },
    isClosed() {
      return false;
    },
  } as unknown as Page;

  return {
    page,
    getGotoCalls: () => gotoCalls,
    getClickMessageEntryCalls: () => clickMessageEntryCalls,
    getClickChatItemCalls: () => clickChatItemCalls,
    getWaitForFunctionCalls: () => waitForFunctionCalls,
  };
}

function createContextManager(params: {
  pages: ReadonlyArray<Page>;
  currentPage?: Page;
}) {
  const pageIds = new Map(params.pages.map((page, index) => [page, `page-${index + 1}`] as const));
  const selectedPageIds: string[] = [];
  let currentPage = params.currentPage;

  const manager = {
    async listAttachedPages() {
      return params.pages;
    },
    getPageId(page: Page) {
      return pageIds.get(page) ?? "page-unknown";
    },
    async selectAttachedPage(_platform: string, pageId: string) {
      selectedPageIds.push(pageId);
      const matchedPage = params.pages.find((page) => pageIds.get(page) === pageId);
      if (!matchedPage) {
        throw new Error(`Unknown page id: ${pageId}`);
      }
      currentPage = matchedPage;
      return matchedPage;
    },
    async getPage(_platform: string) {
      if (!currentPage) {
        throw new Error("No current page configured in test.");
      }
      return currentPage;
    },
  } as unknown as BrowserContextManager;

  return {
    manager,
    getSelectedPageIds: () => selectedPageIds,
  };
}

test("selectChatCandidate matches exact candidate names first", () => {
  const selected = selectChatCandidate(candidates, {
    candidateName: "鲁伟",
    index: undefined,
  });

  assert.equal(selected?.name, "鲁伟");
  assert.equal(selected?.index, 0);
});

test("selectChatCandidate does not fuzzy-match two-character names on one shared character", () => {
  const selected = selectChatCandidate(candidates, {
    candidateName: "鲁明",
    index: undefined,
  });

  assert.equal(selected, undefined);
});

test("selectChatCandidate allows broader fuzzy matching for longer names", () => {
  const selected = selectChatCandidate(candidates, {
    candidateName: "张三",
    index: undefined,
  });

  assert.equal(selected?.name, "张三丰");
  assert.equal(selected?.index, 2);
});

test("ensureChatListLoaded returns immediately when already on a loaded chat page", async () => {
  const current = createTestPage({
    url: `${ZHIPIN_CHAT_URL}?conversation=1`,
    chatListLoaded: true,
  });
  const ctxManager = createContextManager({
    pages: [current.page],
    currentPage: current.page,
  });

  const ready = await ensureChatListLoaded(ctxManager.manager, current.page);

  assert.equal(ready, true);
  assert.equal(current.getGotoCalls(), 0);
  assert.deepEqual(ctxManager.getSelectedPageIds(), []);
});

test("ensureChatListLoaded reuses an already opened chat tab before trying UI click or goto", async () => {
  const current = createTestPage({
    url: "https://www.zhipin.com/web/geek/recommend",
    clickMessageEntryWorks: false,
  });
  const chatTab = createTestPage({
    url: `${ZHIPIN_CHAT_URL}?conversation=2`,
    chatListLoaded: true,
  });
  const ctxManager = createContextManager({
    pages: [current.page, chatTab.page],
    currentPage: current.page,
  });

  const ready = await ensureChatListLoaded(ctxManager.manager, current.page);

  assert.equal(ready, true);
  assert.deepEqual(ctxManager.getSelectedPageIds(), ["page-2"]);
  assert.equal(current.getClickMessageEntryCalls(), 0);
  assert.equal(current.getGotoCalls(), 0);
});

test("ensureChatListLoaded prefers clicking the message entry before goto", async () => {
  const current = createTestPage({
    url: "https://www.zhipin.com/web/geek/recommend",
    clickMessageEntryWorks: true,
    clickLoadsChatList: true,
  });
  const ctxManager = createContextManager({
    pages: [current.page],
    currentPage: current.page,
  });

  const ready = await ensureChatListLoaded(ctxManager.manager, current.page);

  assert.equal(ready, true);
  assert.equal(current.getClickMessageEntryCalls(), 1);
  assert.equal(current.getGotoCalls(), 0);
});

test("ensureChatListLoaded soft-recovers from ERR_ABORTED when goto still lands on the chat page", async () => {
  const current = createTestPage({
    url: "https://www.zhipin.com/web/geek/recommend",
    clickMessageEntryWorks: false,
    gotoBehavior: "err_aborted",
    gotoResultUrl: ZHIPIN_CHAT_URL,
    gotoLoadsChatList: true,
  });
  const ctxManager = createContextManager({
    pages: [current.page],
    currentPage: current.page,
  });

  const ready = await ensureChatListLoaded(ctxManager.manager, current.page);

  assert.equal(ready, true);
  assert.equal(current.getClickMessageEntryCalls(), 1);
  assert.equal(current.getGotoCalls(), 1);
});

test("ensureChatOpen continues on the rebound chat page after reusing another tab", async () => {
  const current = createTestPage({
    url: "https://www.zhipin.com/web/geek/recommend",
    clickMessageEntryWorks: false,
  });
  const chatTab = createTestPage({
    url: `${ZHIPIN_CHAT_URL}?conversation=3`,
    chatListLoaded: true,
    chatCandidates: candidates,
    clickChatItemWorks: true,
  });
  const ctxManager = createContextManager({
    pages: [current.page, chatTab.page],
    currentPage: current.page,
  });

  const result = await ensureChatOpen(ctxManager.manager, current.page, {
    candidateName: "鲁伟",
    index: undefined,
  });

  assert.equal(result?.found, true);
  assert.equal(result?.name, "鲁伟");
  assert.deepEqual(ctxManager.getSelectedPageIds(), ["page-2"]);
  assert.equal(chatTab.getClickChatItemCalls(), 1);
  assert.equal(chatTab.getWaitForFunctionCalls(), 1);
  assert.equal(current.getClickChatItemCalls(), 0);
});
