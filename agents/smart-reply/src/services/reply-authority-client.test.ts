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

const ENRICHED_REQUEST = {
  ...VALID_REQUEST,
  candidateInfo: {
    communicationPosition: "餐饮兼职服务员",
    expectedLocation: "上海",
    expectedPosition: "服务员",
  },
  locationSignals: [
    {
      text: "人民广场",
      source: "candidate_message" as const,
      city: "上海",
      intent: "nearby_store" as const,
      confidence: 0.93,
    },
  ],
  preferredBrand: "肯德基",
};

const GENERIC_SIGNAL_REQUEST = {
  candidateMessage: "兼职怎么算的？两个人需要吗？",
  conversationHistory: [
    "我: 你好，我们正在诚招餐饮兼职服务员，想跟你沟通一下",
    "候选人: 兼职怎么算的？",
    "候选人: 两个人需要吗？",
  ],
  candidateInfo: {
    name: "阳志园",
    age: "24岁",
    experience: "6年",
    communicationPosition: "餐饮兼职服务员",
    expectedLocation: "上海",
    expectedPosition: "服务员",
  },
  target: {
    platform: "zhipin" as const,
    conversationId: "708401971-0",
    candidateId: "708401971-0",
    recruiterUsername: "任思文",
  },
};

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.REPLY_AUTHORITY_URL;
const ORIGINAL_TOKEN = process.env.REPLY_AUTHORITY_BEARER_TOKEN;
const ORIGINAL_TIMEOUT = process.env.REPLY_AUTHORITY_TIMEOUT_MS;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ReplyAuthorityClientModule = typeof import("./reply-authority-client.ts");

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;

  if (ORIGINAL_URL === undefined) delete process.env.REPLY_AUTHORITY_URL;
  else process.env.REPLY_AUTHORITY_URL = ORIGINAL_URL;

  if (ORIGINAL_TOKEN === undefined) delete process.env.REPLY_AUTHORITY_BEARER_TOKEN;
  else process.env.REPLY_AUTHORITY_BEARER_TOKEN = ORIGINAL_TOKEN;

  if (ORIGINAL_TIMEOUT === undefined) delete process.env.REPLY_AUTHORITY_TIMEOUT_MS;
  else process.env.REPLY_AUTHORITY_TIMEOUT_MS = ORIGINAL_TIMEOUT;
});

describe("generateSignedReply", () => {
  it("throws when REPLY_AUTHORITY_URL is missing", async () => {
    delete process.env.REPLY_AUTHORITY_URL;
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "token";

    const { generateSignedReply } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;

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

    const { generateSignedReply } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;
    const result = await generateSignedReply(VALID_REQUEST);
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    const requestId = headers?.["x-request-id"];

    assert.equal(capturedUrl, "https://reply-authority.duliday.com/generate-signed-reply");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(headers?.Authorization, "Bearer client-token");
    assert.match(requestId ?? "", UUID_PATTERN);
    assert.deepEqual(requestBody, {
      ...VALID_REQUEST,
      requestId,
    });
    assert.equal(result.signedEnvelope, "payload.signature");
    assert.equal(result.replyPolicySource, "file");
  });

  it("forwards preferredBrand and candidateInfo signals without local guessing", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;

      return new Response(
        JSON.stringify({
          suggestedReply: "请问您更方便在哪个区域面试？",
          signedEnvelope: "payload.signature",
          envelopeExp: 1712736600,
          confidence: 0.82,
          stage: "job_consultation",
          replyPolicySource: "file",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const { generateSignedReply } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;
    await generateSignedReply(ENRICHED_REQUEST);

    const headers = capturedInit?.headers as Record<string, string> | undefined;
    const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;

    assert.deepEqual(requestBody, {
      ...ENRICHED_REQUEST,
      requestId: headers?.["x-request-id"],
    });
  });

  it("does not invent preferredBrand for generic job titles", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;

      if (String(_input).endsWith("/resolve-recruiter-binding")) {
        return new Response(
          JSON.stringify({
            tenantId: "tenant-001",
            recruiterBinding: {
              platform: "zhipin",
              username: "任思文",
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
          suggestedReply: "先和您确认下方便的门店区域，我再帮您继续对接。",
          signedEnvelope: "payload.signature",
          envelopeExp: 1712736600,
          confidence: 0.72,
          stage: "job_consultation",
          replyPolicySource: "file",
          diagnostics: {
            brandResolutionSource: "none",
            resolvedBrand: "",
            ageGate: { status: "unknown" },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const { generateSignedReply } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;
    const result = await generateSignedReply(GENERIC_SIGNAL_REQUEST);

    const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;

    assert.deepEqual(requestBody, {
      ...GENERIC_SIGNAL_REQUEST,
      target: {
        platform: "zhipin",
        tenantId: "tenant-001",
        conversationId: "708401971-0",
        candidateId: "708401971-0",
        recruiterBinding: {
          platform: "zhipin",
          username: "任思文",
        },
      },
      requestId: requestBody.requestId,
    });
    assert.equal("preferredBrand" in requestBody, false);
    assert.deepEqual(result.diagnostics, {
      brandResolutionSource: "none",
      resolvedBrand: "",
      ageGate: { status: "unknown" },
    });
  });

  it("resolves recruiter binding before signing when only recruiterUsername is provided", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = (init?.headers as Record<string, string>) ?? {};
      requests.push({ url, body, headers });

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

    const { generateSignedReply } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;
    const result = await generateSignedReply(PROXY_REQUEST);

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://reply-authority.duliday.com/resolve-recruiter-binding");
    assert.match(requests[0]?.headers["x-request-id"] ?? "", UUID_PATTERN);
    assert.equal(requests[0]?.headers["x-request-id"], requests[1]?.headers["x-request-id"]);
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
      requestId: requests[1]?.headers["x-request-id"],
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

    const { generateSignedReply, ReplyAuthorityRequestError } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;

    await assert.rejects(
      async () => {
        await generateSignedReply({
          ...PROXY_REQUEST,
          target: {
            ...PROXY_REQUEST.target,
            tenantId: "tenant-001",
          },
        });
      },
      (error: unknown) => {
        if (!(error instanceof ReplyAuthorityRequestError)) {
          return false;
        }
        assert.match(
          error.message,
          /Reply Authority Service recruiter 解析结果与 target\.tenantId 不一致：tenant-002/,
        );
        assert.equal(
          error.meta.url,
          "https://reply-authority.duliday.com/resolve-recruiter-binding",
        );
        assert.equal(error.meta.timeoutMs, 60_000);
        assert.match(error.meta.requestId ?? "", UUID_PATTERN);
        assert.equal(error.cause, undefined);
        return true;
      },
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

    const { generateSignedReply, ReplyAuthorityRequestError } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;

    await assert.rejects(async () => await generateSignedReply(VALID_REQUEST), (error: unknown) => {
      if (!(error instanceof ReplyAuthorityRequestError)) {
        return false;
      }
      assert.match(error.message, /Reply Authority Service 请求失败 \(403\): tenant is not allowed/);
      assert.match(error.message, /url=https:\/\/reply-authority\.duliday\.com\/generate-signed-reply/);
      assert.match(error.message, /timeoutMs=60000/);
      assert.match(error.message, /requestId=/);
      assert.equal(
        error.meta.url,
        "https://reply-authority.duliday.com/generate-signed-reply",
      );
      assert.equal(error.meta.timeoutMs, 60_000);
      assert.match(error.meta.requestId ?? "", UUID_PATTERN);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /tenant is not allowed/);
      return true;
    });
  });

  it("wraps malformed recruiter-resolution payloads with request metadata", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
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

    const { generateSignedReply, ReplyAuthorityRequestError } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;

    await assert.rejects(async () => await generateSignedReply(PROXY_REQUEST), (error: unknown) => {
      if (!(error instanceof ReplyAuthorityRequestError)) {
        return false;
      }

      assert.match(error.message, /Reply Authority Service recruiter 解析 响应校验失败。/);
      assert.equal(
        error.meta.url,
        "https://reply-authority.duliday.com/resolve-recruiter-binding",
      );
      assert.equal(error.meta.timeoutMs, 60_000);
      assert.match(error.meta.requestId ?? "", UUID_PATTERN);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /tenantId/);
      return true;
    });
  });

  it("wraps malformed signed-reply payloads with request metadata", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          suggestedReply: "感谢你的关注！我们这边薪资是综合计算的。",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const { generateSignedReply, ReplyAuthorityRequestError } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;

    await assert.rejects(async () => await generateSignedReply(VALID_REQUEST), (error: unknown) => {
      if (!(error instanceof ReplyAuthorityRequestError)) {
        return false;
      }

      assert.match(error.message, /Reply Authority Service 签名回复 响应校验失败。/);
      assert.equal(
        error.meta.url,
        "https://reply-authority.duliday.com/generate-signed-reply",
      );
      assert.equal(error.meta.timeoutMs, 60_000);
      assert.match(error.meta.requestId ?? "", UUID_PATTERN);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /signedEnvelope/);
      return true;
    });
  });

  it("wraps AbortError with request metadata and preserves the cause", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    };

    const { generateSignedReply, ReplyAuthorityRequestError } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;

    await assert.rejects(async () => await generateSignedReply(VALID_REQUEST), (error: unknown) => {
      if (!(error instanceof ReplyAuthorityRequestError)) {
        return false;
      }
      assert.match(error.message, /Reply Authority Service 请求超时。/);
      assert.equal(
        error.meta.url,
        "https://reply-authority.duliday.com/generate-signed-reply",
      );
      assert.equal(error.meta.timeoutMs, 60_000);
      assert.match(error.meta.requestId ?? "", UUID_PATTERN);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.name, "AbortError");
      return true;
    });
  });

  it("honors REPLY_AUTHORITY_TIMEOUT_MS when set to a positive integer", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";
    process.env.REPLY_AUTHORITY_TIMEOUT_MS = "45000";

    globalThis.fetch = async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    };

    const { generateSignedReply, ReplyAuthorityRequestError } = (await import(
      `./reply-authority-client.ts?case=${Date.now()}`
    )) as ReplyAuthorityClientModule;

    await assert.rejects(async () => await generateSignedReply(VALID_REQUEST), (error: unknown) => {
      if (!(error instanceof ReplyAuthorityRequestError)) {
        return false;
      }
      assert.equal(error.meta.timeoutMs, 45_000);
      assert.match(error.message, /timeoutMs=45000/);
      return true;
    });
  });

  it("falls back to the default when REPLY_AUTHORITY_TIMEOUT_MS is invalid", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    };

    for (const invalid of ["", "   ", "abc", "0", "-1", "1.5", "1e3"]) {
      process.env.REPLY_AUTHORITY_TIMEOUT_MS = invalid;

      const { generateSignedReply, ReplyAuthorityRequestError } = (await import(
        `./reply-authority-client.ts?case=${Date.now()}-${encodeURIComponent(invalid)}`
      )) as ReplyAuthorityClientModule;

      await assert.rejects(async () => await generateSignedReply(VALID_REQUEST), (error: unknown) => {
        if (!(error instanceof ReplyAuthorityRequestError)) {
          return false;
        }
        assert.equal(
          error.meta.timeoutMs,
          60_000,
          `invalid value ${JSON.stringify(invalid)} should fall back to 60000`,
        );
        return true;
      });
    }
  });
});
