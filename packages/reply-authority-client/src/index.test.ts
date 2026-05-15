import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  collectFinalSignedReply,
  generateSignedReply,
  GenerateReplyToolInputSchema,
  parseSseFrame,
  ReplyAuthorityRequestError,
  streamGenerateSignedReply,
} from "./index.ts";
import type { ReplyStreamEvent } from "./index.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.REPLY_AUTHORITY_URL;
const ORIGINAL_TOKEN = process.env.REPLY_AUTHORITY_BEARER_TOKEN;
const ORIGINAL_TIMEOUT = process.env.REPLY_AUTHORITY_TIMEOUT_MS;

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

const FINAL_EVENT = {
  type: "final",
  sequence: 3,
  timestamp: "2026-05-11T00:00:00.000Z",
  safeToSend: true,
  suggestedReply: "感谢你的关注！我们这边薪资是综合计算的。",
  signedEnvelope: "payload.signature",
  envelopeExp: 1_712_736_600,
  confidence: 0.85,
  stage: "job_consultation",
  replyPolicySource: "file",
} as const;

function sseFrame(event: unknown): string {
  return `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(
    event,
  )}\n\n`;
}

function sseResponse(
  events: readonly unknown[],
  contentType = "text/event-stream; charset=utf-8",
): Response {
  return new Response(events.map((event) => sseFrame(event)).join(""), {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

function streamedTextResponse(text: string, contentType = "text/event-stream"): Response {
  const encoded = new TextEncoder().encode(text);
  const splitAt = Math.max(1, Math.floor(encoded.length / 2));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": contentType },
    },
  );
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;

  if (ORIGINAL_URL === undefined) delete process.env.REPLY_AUTHORITY_URL;
  else process.env.REPLY_AUTHORITY_URL = ORIGINAL_URL;

  if (ORIGINAL_TOKEN === undefined) delete process.env.REPLY_AUTHORITY_BEARER_TOKEN;
  else process.env.REPLY_AUTHORITY_BEARER_TOKEN = ORIGINAL_TOKEN;

  if (ORIGINAL_TIMEOUT === undefined) delete process.env.REPLY_AUTHORITY_TIMEOUT_MS;
  else process.env.REPLY_AUTHORITY_TIMEOUT_MS = ORIGINAL_TIMEOUT;
});

describe("@roll-agent/reply-authority-client", () => {
  it("parses a standard SSE frame", () => {
    const event = parseSseFrame(
      sseFrame({
        type: "draft.delta",
        sequence: 1,
        timestamp: "2026-05-11T00:00:00.000Z",
        delta: "你好",
      }),
    );

    assert.equal(event?.type, "draft.delta");
    assert.equal(event?.sequence, 1);
    assert.equal(event?.["delta"], "你好");
  });

  it("streams known events and collects the final signed reply", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      sseResponse([
        {
          type: "stream.started",
          sequence: 1,
          timestamp: "2026-05-11T00:00:00.000Z",
          requestId: "req-1",
        },
        {
          type: "draft.delta",
          sequence: 2,
          timestamp: "2026-05-11T00:00:01.000Z",
          delta: "感谢你的关注！",
        },
        FINAL_EVENT,
        {
          type: "stream.completed",
          sequence: 4,
          timestamp: "2026-05-11T00:00:02.000Z",
          ok: true,
        },
      ]);

    const events: string[] = [];
    const final = await collectFinalSignedReply(
      (async function* () {
        for await (const event of streamGenerateSignedReply(VALID_REQUEST)) {
          events.push(event.type);
          yield event;
        }
      })(),
    );

    assert.deepEqual(events, ["stream.started", "draft.delta", "final", "stream.completed"]);
    assert.equal(final.signedEnvelope, "payload.signature");
  });

  it("accepts case-insensitive SSE content type and a trailing frame", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      streamedTextResponse(
        sseFrame({
          ...FINAL_EVENT,
          sequence: 1,
          suggestedReply: "谢谢关注，薪资可以详聊。",
        }).trimEnd(),
        "Text/Event-Stream; Charset=UTF-8",
      );

    const events: ReplyStreamEvent[] = [];
    for await (const event of streamGenerateSignedReply(VALID_REQUEST)) {
      events.push(event);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "final");
    assert.equal(events[0]?.["suggestedReply"], "谢谢关注，薪资可以详聊。");
  });

  it("surfaces HTTP JSON errors before SSE starts", async () => {
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

    await assert.rejects(
      async () => {
        for await (const event of streamGenerateSignedReply(VALID_REQUEST)) {
          assert.ok(event);
          assert.fail("stream should fail before yielding events");
        }
      },
      (error: unknown) =>
        error instanceof ReplyAuthorityRequestError && /tenant is not allowed/.test(error.message),
    );
  });

  it("fails when the SSE stream sends an error event", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      sseResponse([
        {
          type: "stream.started",
          sequence: 1,
          timestamp: "2026-05-11T00:00:00.000Z",
        },
        {
          type: "error",
          sequence: 2,
          timestamp: "2026-05-11T00:00:01.000Z",
          statusCode: 403,
          error: "Forbidden",
          message: "recruiterBinding 与 tenantId 不匹配",
        },
      ]);

    await assert.rejects(
      async () => {
        for await (const event of streamGenerateSignedReply(VALID_REQUEST)) {
          assert.ok(event);
          // Drain until the error event is reached.
        }
      },
      (error: unknown) =>
        error instanceof ReplyAuthorityRequestError &&
        /recruiterBinding 与 tenantId 不匹配/.test(error.message),
    );
  });

  it("fails on sequence gaps", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      sseResponse([
        {
          type: "stream.started",
          sequence: 1,
          timestamp: "2026-05-11T00:00:00.000Z",
        },
        {
          type: "draft.delta",
          sequence: 3,
          timestamp: "2026-05-11T00:00:01.000Z",
          delta: "跳号",
        },
      ]);

    await assert.rejects(
      async () => {
        for await (const event of streamGenerateSignedReply(VALID_REQUEST)) {
          assert.ok(event);
          // Drain until the sequence gap is detected.
        }
      },
      (error: unknown) =>
        error instanceof ReplyAuthorityRequestError && /sequence 不连续/.test(error.message),
    );
  });

  it("fails when the stream ends before final", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    globalThis.fetch = async () =>
      sseResponse([
        {
          type: "stream.started",
          sequence: 1,
          timestamp: "2026-05-11T00:00:00.000Z",
        },
      ]);

    await assert.rejects(
      async () => {
        for await (const event of streamGenerateSignedReply(VALID_REQUEST)) {
          assert.ok(event);
          // Drain until EOF.
        }
      },
      (error: unknown) =>
        error instanceof ReplyAuthorityRequestError && /final 前结束/.test(error.message),
    );
  });

  it("keeps the existing one-shot JSON behavior", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    let capturedBody: unknown;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as unknown;

      return new Response(
        JSON.stringify({
          suggestedReply: "感谢你的关注！我们这边薪资是综合计算的。",
          signedEnvelope: "payload.signature",
          envelopeExp: 1_712_736_600,
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

    const final = await generateSignedReply(VALID_REQUEST);

    assert.equal(final.signedEnvelope, "payload.signature");
    assert.equal((capturedBody as { readonly stream?: unknown } | undefined)?.stream, undefined);
  });

  it("preserves modelConfig.reasoning in one-shot requests", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    const parsed = GenerateReplyToolInputSchema.parse({
      ...VALID_REQUEST,
      modelConfig: {
        reasoning: {
          enabled: true,
          effort: "high",
          scope: "all",
        },
      },
    });
    assert.deepEqual(parsed.modelConfig?.reasoning, {
      enabled: true,
      effort: "high",
      scope: "all",
    });

    let capturedBody: unknown;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as unknown;

      return new Response(
        JSON.stringify({
          suggestedReply: "感谢你的关注！我们这边薪资是综合计算的。",
          signedEnvelope: "payload.signature",
          envelopeExp: 1_712_736_600,
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

    await generateSignedReply(parsed);

    assert.deepEqual(
      (capturedBody as { readonly modelConfig?: { readonly reasoning?: unknown } } | undefined)
        ?.modelConfig?.reasoning,
      {
        enabled: true,
        effort: "high",
        scope: "all",
      },
    );
  });

  it("preserves modelConfig.reasoning in streaming requests", async () => {
    process.env.REPLY_AUTHORITY_URL = "https://reply-authority.duliday.com";
    process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

    let capturedBody: unknown;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as unknown;
      return sseResponse([{ ...FINAL_EVENT, sequence: 1 }]);
    };

    const events: ReplyStreamEvent[] = [];
    for await (const event of streamGenerateSignedReply({
      ...VALID_REQUEST,
      modelConfig: {
        reasoning: {
          enabled: false,
        },
      },
    })) {
      events.push(event);
    }

    assert.equal(events[0]?.type, "final");
    assert.deepEqual(
      (
        capturedBody as
          | {
              readonly stream?: unknown;
              readonly modelConfig?: { readonly reasoning?: unknown };
            }
          | undefined
      )?.modelConfig?.reasoning,
      { enabled: false },
    );
    assert.equal((capturedBody as { readonly stream?: unknown } | undefined)?.stream, true);
  });
});
