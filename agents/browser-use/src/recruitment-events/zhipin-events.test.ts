import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentLogger } from "@roll-agent/sdk";
import type { NativeCandidateChatDetails } from "../pages/zhipin/native-page.ts";
import { setRecruitmentEventRecorderForTests, type RecruitmentEventDraft } from "./client.ts";
import {
  recordZhipinCandidateContactedEvent,
  recordZhipinMessageReceivedEvents,
  recordZhipinMessageSentEvent,
  recordZhipinWechatCompletedEvents,
  recordZhipinWechatRequestedEvent,
} from "./zhipin-events.ts";

const logger: AgentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createDetails(
  messages: NativeCandidateChatDetails["messages"] = [],
): NativeCandidateChatDetails {
  return {
    selectedTarget: {
      conversationId: "conversation-1",
      candidateId: "candidate-1",
      candidateName: "张三",
    },
    activePanel: { candidateName: "张三" },
    candidateInfo: {
      name: "张三",
      age: "21岁",
      experience: "2年",
      education: "大专",
      communicationPosition: "肯德基-兼职-全市可安排",
      expectedJobText: "上海·服务员",
      expectedSalary: "3-5K",
      tags: [],
    },
    messages,
  };
}

async function captureEvents(run: () => void): Promise<RecruitmentEventDraft[]> {
  const events: RecruitmentEventDraft[] = [];
  setRecruitmentEventRecorderForTests((event) => {
    events.push(event);
  });

  run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return events;
}

afterEach(() => {
  setRecruitmentEventRecorderForTests(undefined);
});

describe("zhipin recruitment event builders", () => {
  it("keeps unread idempotency stable when only the preview changes", async () => {
    const first = await captureEvents(() => {
      recordZhipinMessageReceivedEvents(
        [
          {
            conversationId: "conversation-1",
            candidateId: "candidate-1",
            name: "张三",
            position: "肯德基服务员",
            preview: "第一条预览",
            unreadCount: 1,
            hasUnread: true,
          },
        ],
        logger,
      );
    });
    const second = await captureEvents(() => {
      recordZhipinMessageReceivedEvents(
        [
          {
            conversationId: "conversation-1",
            candidateId: "candidate-1",
            name: "张三",
            position: "肯德基服务员",
            preview: "第二条预览",
            unreadCount: 2,
            hasUnread: true,
          },
        ],
        logger,
      );
    });

    assert.equal(first[0]?.idempotencyKey, second[0]?.idempotencyKey);
  });

  it("uses reply id rather than message text for sent-message idempotency", async () => {
    const events = await captureEvents(() => {
      recordZhipinMessageSentEvent(
        {
          conversationId: "conversation-1",
          candidateId: "candidate-1",
          replyId: "jti-1",
          candidateName: "张三",
          message: "您好",
          unreadCountBeforeReply: 2,
          candidateDetails: createDetails(),
        },
        logger,
      );
      recordZhipinMessageSentEvent(
        {
          conversationId: "conversation-1",
          candidateId: "candidate-1",
          replyId: "jti-2",
          candidateName: "张三",
          message: "您好",
          unreadCountBeforeReply: 2,
          candidateDetails: createDetails(),
        },
        logger,
      );
    });

    assert.equal(events.length, 2);
    assert.notEqual(events[0]?.idempotencyKey, events[1]?.idempotencyKey);
  });

  it("skips events when candidate position is unavailable", async () => {
    const events = await captureEvents(() => {
      recordZhipinCandidateContactedEvent(
        {
          found: true,
          cardSelector: ".candidate-card-wrap",
          candidateId: "candidate-1",
          name: "张三",
          hasGreetButton: true,
          clicked: true,
        },
        logger,
      );
    });

    assert.deepEqual(events, []);
  });

  it("records one completed wechat event per conversation details read", async () => {
    const events = await captureEvents(() => {
      recordZhipinWechatCompletedEvents(
        createDetails([
          {
            index: 1,
            sender: "system",
            messageType: "wechat-exchange",
            content: "微信号: wx_12345",
            time: "10:20",
          },
          {
            index: 2,
            sender: "system",
            messageType: "wechat-exchange",
            content: "微信号: wx_67890",
            time: "10:21",
          },
        ]),
        "conversation-1",
        "candidate-1",
        logger,
      );
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.details["wechatNumber"], "wx_12345");
  });

  it("marks successful exchange with a returned wechat number as accepted", async () => {
    const events = await captureEvents(() => {
      recordZhipinWechatRequestedEvent(
        {
          conversationId: "conversation-1",
          candidateId: "candidate-1",
          candidateName: "张三",
          wechatNumber: "wx_12345",
          candidateDetails: createDetails(),
        },
        logger,
      );
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.details["exchangeType"], "accepted");
  });
});
