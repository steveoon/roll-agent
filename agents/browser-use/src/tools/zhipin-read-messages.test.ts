import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ChatListItem } from "../pages/zhipin/chat-navigation.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  setZhipinReadMessagesDepsForTests,
  zhipinReadMessages,
} from "./zhipin-read-messages.ts";

function createTestContext(): AgentContext {
  return {
    llm: {
      generateText: async () => "",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

function createNoopNativeSession() {
  return {
    begin: async () => true,
    highlightSelector: async () => true,
    succeed: async () => true,
    fail: async () => true,
  };
}

function createNativePage(
  options: {
    readonly listReady?: boolean;
    readonly candidates?: ReadonlyArray<ChatListItem>;
    readonly onClose?: () => void;
  } = {},
): ZhipinNativePagePort {
  return {
    async waitForSelector() {
      return options.listReady ?? true;
    },
    async readChatCandidates() {
      return options.candidates ?? [];
    },
    close() {
      options.onClose?.();
    },
  } as unknown as ZhipinNativePagePort;
}

afterEach(() => {
  setZhipinReadMessagesDepsForTests(undefined);
});

describe("zhipin_read_messages", () => {
  it("defaults to returning the full message list instead of unread-only", () => {
    const parsed = zhipinReadMessages.input.parse({});

    assert.equal(parsed.onlyUnread, false);
    assert.equal(parsed.sortBy, "time");
    assert.equal(parsed.autoScroll, true);
    assert.equal(parsed.maxScrolls, 4);
  });

  it("reads chat candidates through native backend", async () => {
    let openNativePageCalls = 0;
    let closeCalls = 0;

    setZhipinReadMessagesDepsForTests({
      openNativePagePort: async () => {
        openNativePageCalls += 1;
        return createNativePage({
          candidates: [
            {
              conversationId: "c-1",
              candidateId: "g-1",
              name: "张三",
              index: 0,
              position: "前端工程师",
              hasUnread: true,
              unreadCount: 2,
              lastMessageTime: "10:20",
              messagePreview: "你好",
            },
          ],
          onClose: () => {
            closeCalls += 1;
          },
        });
      },
      createNativeVisualActivitySession: () => createNoopNativeSession() as never,
    });

    const result = await zhipinReadMessages.execute(
      { onlyUnread: false, sortBy: "time", autoScroll: false, maxScrolls: 0 },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.total, 1);
    assert.equal(result.candidates[0]?.name, "张三");
    assert.equal(result.stats.withUnread, 1);
    assert.equal(openNativePageCalls, 1);
    assert.equal(closeCalls, 1);
  });

  it("fails closed when native backend is unavailable", async () => {
    setZhipinReadMessagesDepsForTests({
      openNativePagePort: async () => {
        throw new Error("No BOSS chat page found");
      },
      createNativeVisualActivitySession: () => createNoopNativeSession() as never,
    });

    const result = await zhipinReadMessages.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.total, 0);
    assert.deepEqual(result.candidates, []);
  });
});
