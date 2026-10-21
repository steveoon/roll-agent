import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";
import {
  isRecoverableChatGptError,
  ChatGptStreamInterruptedError,
  guardChatGptResponseBody,
} from "./chatgpt-recovery.ts";

test("ChatGPT recovery uses typed transport evidence rather than error message matching", () => {
  assert.equal(isRecoverableChatGptError(new Error("ECONNRESET")), false);
  assert.equal(isRecoverableChatGptError(new Error("missing response.completed")), false);
  assert.equal(isRecoverableChatGptError(new ChatGptAuthError("network_error", "offline")), true);
  assert.equal(isRecoverableChatGptError(new ChatGptStreamInterruptedError()), true);
  assert.equal(
    isRecoverableChatGptError(
      new APICallError({
        message: "safe",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: undefined,
        isRetryable: false,
        cause: new ChatGptAuthError("network_error", "offline"),
      }),
    ),
    true,
  );
});

test("ChatGPT recovery never treats authorization, quota or arbitrary 429 errors as transport", () => {
  for (const code of [
    "insufficient_quota",
    "subscription_sharing_usage_limit_exceeded",
    "login_required",
    "unsupported_effort",
  ]) {
    assert.equal(isRecoverableChatGptError(new ChatGptAuthError(code, "terminal", 429)), false);
  }
  for (const statusCode of [400, 401, 403, 429]) {
    assert.equal(
      isRecoverableChatGptError(
        new APICallError({
          message: "terminal",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: undefined,
          statusCode,
          isRetryable: true,
        }),
      ),
      false,
    );
  }
  for (const code of [
    "insufficient_quota",
    "subscription_sharing_user_not_eligible",
    "unsupported_effort",
    "unknown_business_error",
  ]) {
    assert.equal(
      isRecoverableChatGptError(
        new APICallError({
          message: "terminal despite status",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: undefined,
          statusCode: 503,
          data: { error: { code } },
          isRetryable: true,
        }),
      ),
      false,
    );
  }
  const circular = new Error("circular");
  circular.cause = circular;
  assert.equal(isRecoverableChatGptError(circular), false);
});

test("HTTP body transport failure is typed and sanitized while abort remains cancellation", async () => {
  let notices = 0;
  const makeResponse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new TypeError("private-transport-detail");
        },
      }),
    );
  const response = guardChatGptResponseBody(makeResponse(), undefined, () => {
    notices += 1;
  });
  await assert.rejects(response.text(), (error: unknown) => {
    assert.ok(error instanceof ChatGptAuthError);
    assert.equal(error.code, "network_error");
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(notices, 1);
  const abort = new AbortController();
  abort.abort(new Error("cancelled-fixture"));
  await assert.rejects(
    guardChatGptResponseBody(makeResponse(), abort.signal, () => {
      notices += 1;
    }).text(),
    /cancelled-fixture/,
  );
  assert.equal(notices, 1);
});

test("response body cleanup releases its reader even when the observer throws", async () => {
  const source = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        throw new TypeError("private-transport-detail");
      },
    }),
  );
  const wrapped = guardChatGptResponseBody(source, undefined, () => {
    throw new Error("private-observer-detail");
  });
  await assert.rejects(wrapped.text(), (error: unknown) => {
    assert.ok(error instanceof ChatGptAuthError);
    assert.equal(error.code, "network_error");
    return true;
  });
  assert.equal(source.body?.locked, false);
});

test("response cancellation always unlocks its reader without publishing a failure", async () => {
  for (const rejects of [false, true]) {
    let notices = 0;
    let reason: unknown;
    const rejected = new Error("cancel-cleanup-failed");
    const source = new Response(
      new ReadableStream<Uint8Array>({
        cancel(value) {
          reason = value;
          if (rejects) throw rejected;
        },
      }),
    );
    const wrapped = guardChatGptResponseBody(source, undefined, () => {
      notices++;
    });
    const cancelled = wrapped.body?.cancel("consumer-cancelled");
    assert.ok(cancelled);
    if (rejects) await assert.rejects(cancelled, (error: unknown) => error === rejected);
    else await cancelled;
    assert.equal(reason, "consumer-cancelled");
    assert.equal(notices, 0);
    assert.equal(source.body?.locked, false);
  }
});

test("response guarding preserves status and headers and leaves nonstream responses alone", async () => {
  const source = new Response("fixture", {
    status: 201,
    statusText: "Created",
    headers: { "x-fixture": "preserved" },
  });
  const wrapped = guardChatGptResponseBody(source, undefined, undefined);
  assert.equal(wrapped.status, 201);
  assert.equal(wrapped.statusText, "Created");
  assert.equal(wrapped.headers.get("x-fixture"), "preserved");
  assert.equal(await wrapped.text(), "fixture");
  assert.equal(source.body?.locked, false);
  for (const untouched of [
    new Response(null, { status: 204 }),
    new Response("denied", { status: 403 }),
  ]) {
    assert.equal(guardChatGptResponseBody(untouched, undefined, undefined), untouched);
  }
});
