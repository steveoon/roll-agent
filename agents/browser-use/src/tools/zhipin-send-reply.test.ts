import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  resetReplyAuthorityKeyStoreForTests,
  setReplyAuthorityKeysForTests,
} from "../reply-authority/key-store.ts";
import { resetReplyEnvelopeReplayStoreForTests } from "../reply-authority/replay-store.ts";
import { setReplyAuthorityKeysLoaded } from "../runtime-holder.ts";
import { setVisualActivityEnabledForTests } from "../visual-activity.ts";
import { setZhipinSendReplyDepsForTests, zhipinSendReply } from "./zhipin-send-reply.ts";

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

function createSignedEnvelope(jti = "reply-preview-hide-test"): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 2,
    iss: "reply-authority-service",
    kid: "reply-signing-key-test",
    jti,
    iat: now - 5,
    exp: now + 300,
    aud: "browser-use-agent/zhipin_send_reply",
    platform: "zhipin",
    tenantId: "tenant-001",
    conversationId: "685501091-0",
    candidateId: "candidate-123",
    reply: "你好，欢迎了解这个岗位。",
    policyVersion: "tenant:file:v1",
    recruiterBinding: {
      platform: "zhipin",
      username: "recruiter-alice",
    },
  };

  setReplyAuthorityKeysForTests([
    {
      kid: payload.kid,
      algorithm: "Ed25519",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      validFrom: "2026-04-10T12:00:00.000Z",
    },
  ]);

  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson, "utf-8").toString("base64url");
  const signatureBase64 = sign(null, Buffer.from(payloadJson, "utf-8"), privateKey).toString(
    "base64url",
  );
  return `${payloadBase64}.${signatureBase64}`;
}

function createNativePage(
  calls: string[],
  overrides: Partial<ZhipinNativePagePort> = {},
): ZhipinNativePagePort {
  return {
    async bringToFront() {
      calls.push("front");
    },
    async evaluateJson(expression: string) {
      if (expression.includes('"mode":"clear"')) {
        calls.push("preview:clear");
      }
      return true;
    },
    async openChat() {
      calls.push("open");
      return {
        found: true,
        conversationId: "685501091-0",
        candidateId: "candidate-123",
        name: "张三",
        index: 0,
        position: "服务员",
        hasUnread: false,
        unreadCount: 0,
        lastMessageTime: "10:20",
        messagePreview: "你好",
      };
    },
    async readActiveChatPanel() {
      return { candidateName: "张三" };
    },
    async readSelectedChatTarget() {
      return {
        conversationId: "685501091-0",
        candidateId: "candidate-123",
        candidateName: "张三",
      };
    },
    async readUsernameEvidence() {
      return [
        {
          text: "recruiter-alice",
          strategy: "css-fallback" as const,
          priority: 4,
          source: ".user-name",
        },
      ];
    },
    async sendChatReply(message: string) {
      calls.push(`send:${message}`);
      return { success: true };
    },
    close() {
      calls.push("close");
    },
    ...overrides,
  } as unknown as ZhipinNativePagePort;
}

afterEach(() => {
  setReplyAuthorityKeysLoaded(false);
  setZhipinSendReplyDepsForTests(undefined);
  setVisualActivityEnabledForTests(undefined);
  resetReplyAuthorityKeyStoreForTests();
  resetReplyEnvelopeReplayStoreForTests();
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

  it("hides the reply preview before sending a prepared reply", async () => {
    const calls: string[] = [];
    const errorLogs: string[] = [];

    setVisualActivityEnabledForTests(true);
    setReplyAuthorityKeysLoaded(true);
    setZhipinSendReplyDepsForTests({
      getReplyAuthorityKeysLoaded: () => true,
      openNativePagePort: async () => createNativePage(calls),
      createNativeVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`session:begin:${label}`);
          return true;
        },
        async previewMouseMotion() {
          return undefined;
        },
        async succeed(label: string) {
          calls.push(`session:succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          calls.push(`session:fail:${label}`);
          return true;
        },
      }),
    });

    const result = await zhipinSendReply.execute(
      {
        signedEnvelope: createSignedEnvelope(),
      },
      createTestContext(errorLogs),
    );

    assert.equal(result.success, true);
    assert.equal(calls.includes("preview:clear"), true);
    assert.equal(calls.includes("open"), false);
    assert.ok(calls.indexOf("preview:clear") < calls.indexOf("session:begin:正在发送回复"));
    assert.ok(calls.some((call) => call.startsWith("send:")));
  });

  it("reopens the signed target when the current selected chat differs", async () => {
    const calls: string[] = [];
    const errorLogs: string[] = [];
    let opened = false;

    setVisualActivityEnabledForTests(true);
    setReplyAuthorityKeysLoaded(true);
    setZhipinSendReplyDepsForTests({
      getReplyAuthorityKeysLoaded: () => true,
      openNativePagePort: async () =>
        createNativePage(calls, {
          async openChat() {
            opened = true;
            calls.push("open");
            return {
              found: true,
              conversationId: "685501091-0",
              candidateId: "candidate-123",
              name: "张三",
              index: 0,
              position: "服务员",
              hasUnread: true,
              unreadCount: 2,
              lastMessageTime: "10:20",
              messagePreview: "你好",
            };
          },
          async readActiveChatPanel() {
            return { candidateName: opened ? "张三" : "李四" };
          },
          async readSelectedChatTarget() {
            if (!opened) {
              return {
                conversationId: "other-conversation",
                candidateId: "other-candidate",
                candidateName: "李四",
              };
            }
            return {
              conversationId: "685501091-0",
              candidateId: "candidate-123",
              candidateName: "张三",
            };
          },
        }),
      createNativeVisualActivitySession: () => ({
        async begin(label: string) {
          calls.push(`session:begin:${label}`);
          return true;
        },
        async previewMouseMotion() {
          return undefined;
        },
        async succeed(label: string) {
          calls.push(`session:succeed:${label}`);
          return true;
        },
        async fail(label: string) {
          calls.push(`session:fail:${label}`);
          return true;
        },
      }),
    });

    const result = await zhipinSendReply.execute(
      {
        signedEnvelope: createSignedEnvelope("reply-reopen-target-test"),
      },
      createTestContext(errorLogs),
    );

    assert.equal(result.success, true);
    assert.equal(calls.includes("open"), true);
    assert.ok(calls.indexOf("open") < calls.findIndex((call) => call.startsWith("send:")));
  });
});
