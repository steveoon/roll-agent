import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  setZhipinExchangeWechatDepsForTests,
  zhipinExchangeWechat,
} from "./zhipin-exchange-wechat.ts";

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

afterEach(() => {
  setZhipinExchangeWechatDepsForTests(undefined);
});

describe("zhipin_exchange_wechat", () => {
  it("opens the target chat and exchanges WeChat through the native page port", async () => {
    const calls: string[] = [];
    const nativePage = {
      async bringToFront() {
        calls.push("front");
      },
      async openChat(input: { readonly conversationId?: string }) {
        calls.push(`open:${input.conversationId}`);
        return {
          found: true,
          conversationId: input.conversationId ?? "",
          candidateId: "candidate-123",
          name: "赵慧珍",
          index: 0,
          position: "",
          hasUnread: false,
          unreadCount: 0,
          lastMessageTime: "",
          messagePreview: "",
        };
      },
      async readSelectedChatTarget() {
        return {
          conversationId: "conversation-1",
          candidateId: "candidate-123",
          candidateName: "赵慧珍",
        };
      },
      async readActiveChatPanel() {
        return { candidateName: "赵慧珍" };
      },
      async exchangeWechat(options?: {
        readonly preClickDelayMs?: number;
        readonly pressDurationMs?: number;
        readonly settleMs?: number;
      }) {
        calls.push("exchange");
        calls.push(
          `timing:${options?.preClickDelayMs}:${options?.pressDurationMs}:${options?.settleMs}`,
        );
        return { success: true, exchanged: true, wechatNumber: "wxid_12345" };
      },
      close() {
        calls.push("close");
      },
    } as unknown as ZhipinNativePagePort;

    setZhipinExchangeWechatDepsForTests({
      openNativePagePort: async () => nativePage,
      createNativeVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`begin:${label}`);
          return true;
        },
        async previewMouseMotion() {},
        async succeed(label: string) {
          calls.push(`succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          calls.push(`fail:${label}`);
          return true;
        },
      }),
    });

    const result = await zhipinExchangeWechat.execute(
      { conversationId: "conversation-1" },
      createTestContext(),
    );

    assert.deepEqual(result, {
      success: true,
      exchanged: true,
      wechatNumber: "wxid_12345",
    });
    assert.deepEqual(calls, [
      "front",
      "begin:正在换微信",
      "open:conversation-1",
      "exchange",
      "timing:900:160:1100",
      "succeed:已完成换微信",
      "close",
    ]);
  });
});
