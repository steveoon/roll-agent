import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { OpenChatResult } from "../pages/zhipin/chat-navigation.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { setZhipinOpenChatDepsForTests, zhipinOpenChat } from "./zhipin-open-chat.ts";

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

function createNoopSession(calls: string[]) {
  return {
    async begin(label: string) {
      calls.push(`begin:${label}`);
      return true;
    },
    async highlightSelector(selector: string) {
      calls.push(`highlight:${selector}`);
      return true;
    },
    async succeed(label: string) {
      calls.push(`succeed:${label}`);
      return true;
    },
    async fail(label: string) {
      calls.push(`fail:${label}`);
      return true;
    },
  };
}

function createNativePage(calls: string[], result: OpenChatResult): ZhipinNativePagePort {
  return {
    async openChat(input: unknown) {
      calls.push(`open:${JSON.stringify(input)}`);
      return result;
    },
    close() {
      calls.push("close");
    },
  } as unknown as ZhipinNativePagePort;
}

afterEach(() => {
  setZhipinOpenChatDepsForTests(undefined);
});

describe("zhipin_open_chat", () => {
  it("opens target chat through the native backend", async () => {
    const calls: string[] = [];

    setZhipinOpenChatDepsForTests({
      openNativePagePort: async () =>
        createNativePage(calls, {
          found: true,
          conversationId: "conversation-1",
          candidateId: "geek-1",
          name: "李四",
          index: 0,
          position: "后端工程师",
          hasUnread: true,
          unreadCount: 2,
          lastMessageTime: "10:20",
          messagePreview: "方便聊聊吗",
        }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChat.execute(
      {
        conversationId: "conversation-1",
        preferUnread: false,
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.conversationId, "conversation-1");
    assert.equal(result.candidateName, "李四");
    assert.equal(
      calls.some((call) => call.includes('"conversationId":"conversation-1"')),
      true,
    );
    assert.equal(calls.at(-1), "close");
  });

  it("fails closed when the native backend cannot open the chat", async () => {
    const calls: string[] = [];

    setZhipinOpenChatDepsForTests({
      openNativePagePort: async () =>
        createNativePage(calls, {
          found: false,
          conversationId: "",
          candidateId: "",
          name: "王五",
          index: -1,
          position: "",
          hasUnread: false,
          unreadCount: 0,
          lastMessageTime: "",
          messagePreview: "",
          error: "未找到候选人: 王五",
        }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinOpenChat.execute(
      { candidateName: "王五", preferUnread: false },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.error, "未找到候选人: 王五");
    assert.equal(calls.includes("fail:打开聊天失败"), true);
    assert.equal(calls.at(-1), "close");
  });
});
