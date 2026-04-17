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
    recruiterBinding: {
      platform: "zhipin" as const,
      username: "recruiter-alice",
    },
  },
};

const PROXY_REQUEST = {
  candidateMessage: "你好，请问薪资是多少？",
  conversationHistory: ["我: 你好", "候选人: 请问薪资是多少？"],
  target: {
    platform: "zhipin" as const,
    conversationId: "685501091-0",
    candidateId: "candidate-123",
    recruiterUsername: "recruiter-alice",
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

  it("resolves recruiter binding before signing when only recruiterUsername is provided", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body });

      if (url.endsWith("/resolve-recruiter-binding")) {
        return new Response(
          JSON.stringify({
            tenantId: "tenant-001",
            recruiterBinding: {
              platform: "zhipin",
              username: "recruiter-alice",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          suggestedReply: "感谢你的关注！我们这边薪资是综合计算的。",
          signedEnvelope: "payload.signature",
          envelopeExp: 1712736600,
          confidence: 0.85,
          stage: "job_consultation",
          replyPolicySource: "file",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const { generateSignedReply } = await import(`./reply-authority-client.ts?case=${Date.now()}`);
    const result = await generateSignedReply(PROXY_REQUEST);

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://reply-authority.duliday.com/resolve-recruiter-binding");
    assert.deepEqual(requests[0]?.body, {
      platform: "zhipin",
      username: "recruiter-alice",
    });
    assert.equal(requests[1]?.url, "https://reply-authority.duliday.com/generate-signed-reply");
    assert.deepEqual(requests[1]?.body, {
      ...PROXY_REQUEST,
      target: {
        platform: "zhipin",
        tenantId: "tenant-001",
        conversationId: "685501091-0",
        candidateId: "candidate-123",
        recruiterBinding: {
          platform: "zhipin",
          username: "recruiter-alice",
        },
      },
    });
    assert.equal(result.signedEnvelope, "payload.signature");
  });

  it("rejects proxy resolution results that disagree with a caller-supplied tenantId", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          tenantId: "tenant-002",
          recruiterBinding: {
            platform: "zhipin",
            username: "recruiter-alice",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const { generateSignedReply } = await import(`./reply-authority-client.ts?case=${Date.now()}`);

    await assert.rejects(
      async () =>
        await generateSignedReply({
          ...PROXY_REQUEST,
          target: {
            ...PROXY_REQUEST.target,
            tenantId: "tenant-001",
          },
        }),
      /Reply Authority Service recruiter 解析结果与 target\.tenantId 不一致：tenant-002/,
    );
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
