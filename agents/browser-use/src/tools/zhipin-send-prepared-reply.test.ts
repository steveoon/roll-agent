import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import {
  resetPreparedReplyStoreForTests,
  savePreparedReply,
} from "../reply-authority/prepared-reply-store.ts";
import { zhipinSendPreparedReply } from "./zhipin-send-prepared-reply.ts";

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
  resetPreparedReplyStoreForTests();
});

describe("zhipin_send_prepared_reply", () => {
  it("returns structured failure when the prepared reply is missing", async () => {
    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: "prep_missing" },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.sentMessage, "");
    assert.match(result.error ?? "", /preparedReplyId 不存在/);
    assert.equal("signedEnvelope" in result, false);
  });

  it("does not expose the envelope for expired prepared replies", async () => {
    const saved = savePreparedReply(
      {
        signedEnvelope: "payload.signature",
        suggestedReply: "你好",
        stage: "job_consultation",
        confidence: 0.9,
        expiresAt: 1,
      },
      0,
    );

    const result = await zhipinSendPreparedReply.execute(
      { preparedReplyId: saved.preparedReplyId },
      createTestContext(),
    );

    assert.equal(result.success, false);
    assert.equal(result.sentMessage, "");
    assert.equal("signedEnvelope" in result, false);
  });
});
