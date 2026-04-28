import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { OpenChatResult } from "../pages/zhipin/chat-navigation.ts";
import type {
  NativeCandidateChatDetails,
  NativeChatPanelInfo,
  NativeSelectedChatTarget,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import {
  setZhipinGetCandidateInfoDepsForTests,
  zhipinGetCandidateInfo,
} from "./zhipin-get-candidate-info.ts";

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

function createNativePage(options: {
  readonly calls: string[];
  readonly nav?: OpenChatResult;
  readonly selectedTarget?: NativeSelectedChatTarget | null;
  readonly activePanel?: NativeChatPanelInfo | null;
  readonly details?: NativeCandidateChatDetails;
}): ZhipinNativePagePort {
  const selectedTarget = options.selectedTarget ?? {
    conversationId: "conversation-1",
    candidateId: "geek-1",
    candidateName: "李四",
  };
  const activePanel = options.activePanel ?? { candidateName: "李四" };
  return {
    async openChat(input: unknown) {
      options.calls.push(`open:${JSON.stringify(input)}`);
      return (
        options.nav ?? {
          found: true,
          conversationId: "conversation-1",
          candidateId: "geek-1",
          name: "李四",
          index: 0,
          position: "后端工程师",
          hasUnread: false,
          unreadCount: 0,
          lastMessageTime: "10:20",
          messagePreview: "方便聊聊吗",
        }
      );
    },
    async isChatSurfaceOpen() {
      return true;
    },
    async readActiveChatPanel() {
      return activePanel;
    },
    async readSelectedChatTarget() {
      return selectedTarget;
    },
    async waitForChatMessages() {
      options.calls.push("wait-messages");
      return true;
    },
    async readCandidateChatDetails() {
      options.calls.push("read-details");
      return (
        options.details ?? {
          selectedTarget,
          activePanel,
          candidateInfo: {
            name: "李四",
            age: "26岁",
            experience: "3年",
            education: "本科",
            communicationPosition: "花卷科技-前端工程师",
            expectedJobText: "上海·前端工程师",
            expectedSalary: "20-30K",
            tags: ["React"],
          },
          messages: [
            {
              index: 0,
              sender: "candidate",
              messageType: "text",
              content: "你好",
              time: "10:20",
            },
            {
              index: 1,
              sender: "recruiter",
              messageType: "text",
              content: "方便聊聊吗",
              time: "10:21",
            },
          ],
        }
      );
    },
    close() {
      options.calls.push("close");
    },
  } as unknown as ZhipinNativePagePort;
}

afterEach(() => {
  setZhipinGetCandidateInfoDepsForTests(undefined);
});

describe("zhipin_get_candidate_info", () => {
  it("opens the target chat and extracts details through the native backend", async () => {
    const calls: string[] = [];

    setZhipinGetCandidateInfoDepsForTests({
      openNativePagePort: async () => createNativePage({ calls }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinGetCandidateInfo.execute(
      { conversationId: "conversation-1", maxMessages: 20 },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.conversationId, "conversation-1");
    assert.equal(result.candidateInfo.name, "李四");
    assert.equal(result.candidateInfo.communicationPosition, "花卷科技-前端工程师");
    assert.equal(result.candidateInfo.expectedLocation, "上海");
    assert.equal(result.candidateInfo.expectedPosition, "前端工程师");
    assert.equal(result.preferredBrand, "花卷科技");
    assert.deepEqual(result.formattedHistory, ["求职者: 你好", "我: 方便聊聊吗"]);
    assert.equal(result.stats.totalMessages, 2);
    assert.equal(calls.includes("wait-messages"), true);
    assert.equal(calls.includes("read-details"), true);
    assert.equal(calls.at(-1), "close");
  });

  it("returns a structured failure when the active panel is not synchronized", async () => {
    const calls: string[] = [];

    setZhipinGetCandidateInfoDepsForTests({
      openNativePagePort: async () =>
        createNativePage({
          calls,
          activePanel: { candidateName: "王五" },
        }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
    });

    const result = await zhipinGetCandidateInfo.execute(
      { candidateName: "李四", maxMessages: 20 },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /右侧聊天面板未切换到 李四/);
    assert.equal(calls.includes("fail:聊天面板未同步"), true);
    assert.equal(calls.at(-1), "close");
  });
});
