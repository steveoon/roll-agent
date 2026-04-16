import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const VALID_REQUEST = {
  candidateMessage: "你好，请问薪资是多少？",
  conversationHistory: ["我: 你好", "候选人: 请问薪资是多少？"],
  target: {
    platform: "zhipin" as const,
    tenantId: "tenant-001",
    conversationId: "685501091-0",
    candidateId: "candidate-123",
  },
};

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.REPLY_AUTHORITY_URL;
const ORIGINAL_TOKEN = process.env.REPLY_AUTHORITY_BEARER_TOKEN;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;

  if (ORIGINAL_URL === undefined) delete process.env.REPLY_AUTHORITY_URL;
  else process.env.REPLY_AUTHORITY_URL = ORIGINAL_URL;

  if (ORIGINAL_TOKEN === undefined) delete process.env.REPLY_AUTHORITY_BEARER_TOKEN;
  else process.env.REPLY_AUTHORITY_BEARER_TOKEN = ORIGINAL_TOKEN;
});

describe("generateSignedReply", () => {
  it("throws when REPLY_AUTHORITY_URL is missing", async () => {
    delete process.env.REPLY_AUTHORITY_URL;
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "token";

    const { generateSignedReply } = await import(`./reply-authority-client.ts?case=${Date.now()}`);

    await assert.rejects(
      async () => await generateSignedReply(VALID_REQUEST),
      /REPLY_AUTHORITY_URL 未配置/,
    );
  });

  it("posts to generate-signed-reply with bearer auth and parses the response", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;

      return new Response(
        JSON.stringify({
          suggestedReply: "感谢你的关注！我们这边薪资是综合计算的。",
          signedEnvelope: "payload.signature",
          envelopeExp: 1712736600,
          confidence: 0.85,
          stage: "job_consultation",
          replyPolicySource: "file",
          diagnostics: { source: "authority-service" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const { generateSignedReply } = await import(`./reply-authority-client.ts?case=${Date.now()}`);
    const result = await generateSignedReply(VALID_REQUEST);

    assert.equal(capturedUrl, "https://reply-authority.duliday.com/generate-signed-reply");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(
      (capturedInit?.headers as Record<string, string>)?.Authorization,
      "Bearer client-token",
    );
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), VALID_REQUEST);
    assert.equal(result.signedEnvelope, "payload.signature");
    assert.equal(result.replyPolicySource, "file");
  });

  it("surfaces service error messages from JSON error payloads", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          statusCode: 403,
          error: "Forbidden",
          message: "tenant is not allowed",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );

    const { generateSignedReply } = await import(`./reply-authority-client.ts?case=${Date.now()}`);

    await assert.rejects(
      async () => await generateSignedReply(VALID_REQUEST),
      /Reply Authority Service 请求失败 \(403\): tenant is not allowed/,
    );
  });
});
