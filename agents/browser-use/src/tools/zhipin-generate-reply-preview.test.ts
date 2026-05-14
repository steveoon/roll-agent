import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ReplyStreamEvent } from "@roll-agent/reply-authority-client";
import type {
  NativeCandidateChatDetails,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import {
  consumePreparedReply,
  resetPreparedReplyStoreForTests,
} from "../reply-authority/prepared-reply-store.ts";
import {
  setZhipinGenerateReplyPreviewDepsForTests,
  zhipinGenerateReplyPreview,
} from "./zhipin-generate-reply-preview.ts";

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
      calls.push(`session:${label}`);
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

function createPreviewSession(calls: string[]) {
  return {
    async begin(label: string) {
      calls.push(`preview:begin:${label}`);
      return true;
    },
    async updateStatus(label: string) {
      calls.push(`preview:status:${label}`);
      return true;
    },
    async updateDraft(draftText: string, provisional: boolean) {
      calls.push(`preview:draft:${provisional ? "draft" : "final"}:${draftText}`);
      return true;
    },
    async complete(label: string, finalReply: string) {
      calls.push(`preview:complete:${label}:${finalReply}`);
      return true;
    },
    async fail(label: string) {
      calls.push(`preview:fail:${label}`);
      return true;
    },
  };
}

function createChatDetails(
  selectedTarget: NativeCandidateChatDetails["selectedTarget"] = {
    conversationId: "conv-1",
    candidateId: "cand-1",
    candidateName: "张三",
  },
): NativeCandidateChatDetails {
  return {
    selectedTarget,
    activePanel: { candidateName: "张三" },
    candidateInfo: {
      name: "张三",
      age: "22岁",
      experience: "1年",
      education: "高中",
      communicationPosition: "肯德基-服务员",
      expectedJobText: "上海·服务员",
      expectedSalary: "5-6K",
      tags: ["全职"],
    },
    messages: [
      {
        index: 0,
        sender: "recruiter" as const,
        messageType: "text" as const,
        content: "你好",
        time: "10:19",
      },
      {
        index: 1,
        sender: "candidate" as const,
        messageType: "text" as const,
        content: "薪资多少？",
        time: "10:20",
      },
    ],
  };
}

function createNativePage(
  calls: string[],
  overrides: Partial<ZhipinNativePagePort> = {},
): ZhipinNativePagePort {
  return {
    async bringToFront() {
      calls.push("front");
    },
    async openChat(input: unknown) {
      calls.push(`open:${JSON.stringify(input)}`);
      return {
        found: true,
        conversationId: "conv-1",
        candidateId: "cand-1",
        name: "张三",
        index: 0,
        position: "服务员",
        hasUnread: true,
        unreadCount: 1,
        lastMessageTime: "10:20",
        messagePreview: "薪资多少？",
      };
    },
    async isChatSurfaceOpen() {
      return true;
    },
    async readActiveChatPanel() {
      return { candidateName: "张三" };
    },
    async readSelectedChatTarget() {
      return {
        conversationId: "conv-1",
        candidateId: "cand-1",
        candidateName: "张三",
      };
    },
    async waitForChatMessages() {
      return true;
    },
    async readCandidateChatDetails() {
      return createChatDetails();
    },
    async readUsernameEvidence() {
      return [
        {
          text: "任思文",
          strategy: "css-fallback" as const,
          priority: 4,
          source: ".user-name",
        },
      ];
    },
    close() {
      calls.push("close");
    },
    ...overrides,
  } as unknown as ZhipinNativePagePort;
}

async function* createMockStream(): AsyncGenerator<ReplyStreamEvent> {
  yield {
    type: "stream.started",
    sequence: 1,
    timestamp: "2026-05-11T00:00:00.000Z",
    requestId: "req-1",
  };
  yield {
    type: "phase.started",
    sequence: 2,
    timestamp: "2026-05-11T00:00:01.000Z",
    phase: "reply_generation",
    label: "生成回复草稿",
  };
  yield {
    type: "draft.started",
    sequence: 3,
    timestamp: "2026-05-11T00:00:02.000Z",
  };
  yield {
    type: "draft.delta",
    sequence: 4,
    timestamp: "2026-05-11T00:00:03.000Z",
    delta: "您好，",
  };
  yield {
    type: "draft.delta",
    sequence: 5,
    timestamp: "2026-05-11T00:00:04.000Z",
    delta: "薪资可以详聊。",
  };
  yield {
    type: "final",
    sequence: 6,
    timestamp: "2026-05-11T00:00:05.000Z",
    safeToSend: true,
    suggestedReply: "您好，薪资可以详聊。",
    signedEnvelope: "payload.signature",
    envelopeExp: 4_102_444_800,
    confidence: 0.9,
    stage: "job_consultation",
    replyPolicySource: "file",
  };
  yield {
    type: "stream.completed",
    sequence: 7,
    timestamp: "2026-05-11T00:00:06.000Z",
    ok: true,
  };
}

afterEach(() => {
  setZhipinGenerateReplyPreviewDepsForTests(undefined);
  resetPreparedReplyStoreForTests();
});

describe("zhipin_generate_reply_preview", () => {
  it("renders stream progress and stores a prepared reply without exposing the envelope", async () => {
    const calls: string[] = [];
    let capturedCandidateMessage = "";
    let capturedReasoning: unknown;

    setZhipinGenerateReplyPreviewDepsForTests({
      openNativePagePort: async () => createNativePage(calls),
      createNativeVisualActivitySession: () => createNoopSession(calls),
      createReplyPreviewVisualSession: () => createPreviewSession(calls),
      streamGenerateSignedReply: (input) => {
        capturedCandidateMessage = input.candidateMessage;
        capturedReasoning = input.modelConfig?.reasoning;
        return createMockStream();
      },
    });

    const result = await zhipinGenerateReplyPreview.execute(
      {
        conversationId: "conv-1",
        maxMessages: 20,
        reasoning: {
          enabled: true,
          effort: "high",
          scope: "all",
        },
      },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.equal(result.suggestedReply, "您好，薪资可以详聊。");
    assert.equal(result.requestId, "req-1");
    assert.equal(capturedCandidateMessage, "薪资多少？");
    assert.deepEqual(capturedReasoning, {
      enabled: true,
      effort: "high",
      scope: "all",
    });
    assert.equal("signedEnvelope" in result, false);
    assert.ok(result.preparedReplyId);
    assert.equal(calls.includes("preview:draft:draft:您好，薪资可以详聊。"), true);
    assert.equal(calls.includes("preview:complete:回复已生成:您好，薪资可以详聊。"), true);

    const consumed = consumePreparedReply(result.preparedReplyId ?? "", 1_800_000_000);
    assert.equal(consumed.ok, true);
    if (consumed.ok) {
      assert.equal(consumed.record.signedEnvelope, "payload.signature");
    }
  });

  it("fails before streaming when the details target is stale", async () => {
    const calls: string[] = [];
    let streamCalled = false;

    setZhipinGenerateReplyPreviewDepsForTests({
      openNativePagePort: async () =>
        createNativePage(calls, {
          async readCandidateChatDetails() {
            return createChatDetails({
              conversationId: "conv-2",
              candidateId: "cand-2",
              candidateName: "李四",
            });
          },
        }),
      createNativeVisualActivitySession: () => createNoopSession(calls),
      createReplyPreviewVisualSession: () => createPreviewSession(calls),
      streamGenerateSignedReply: () => {
        streamCalled = true;
        return createMockStream();
      },
    });

    const result = await zhipinGenerateReplyPreview.execute(
      { conversationId: "conv-1", maxMessages: 20 },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /聊天详情目标与当前选中会话不一致/);
    assert.equal(result.preparedReplyId, undefined);
    assert.equal(streamCalled, false);
  });
});
