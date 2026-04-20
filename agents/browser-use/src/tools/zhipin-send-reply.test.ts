import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import { setReplyAuthorityKeysLoaded } from "../runtime-holder.ts";
import { zhipinSendReply } from "./zhipin-send-reply.ts";

function createTestContext(errorLogs: string[]): AgentContext {
  return {
    llm: {
      generateText: async () => "",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => {
        errorLogs.push(message);
      },
    },
  };
}

afterEach(() => {
  setReplyAuthorityKeysLoaded(false);
});

describe("zhipin_send_reply", () => {
  it("rejects early when Reply Authority keys are not preloaded", async () => {
    const errorLogs: string[] = [];

    setReplyAuthorityKeysLoaded(false);
    const result = await zhipinSendReply.execute(
      {
        signedEnvelope: "payload.signature",
      },
      createTestContext(errorLogs),
    );

    assert.equal(result.success, false);
    assert.equal(result.sentMessage, "");
    assert.match(result.error ?? "", /Reply Authority 公钥尚未成功预加载/);
    assert.equal(errorLogs.length, 1);
    assert.match(errorLogs[0] ?? "", /browser_status\.replyAuthorityKeysLoaded/);
  });
});
