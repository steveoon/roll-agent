import assert from "node:assert/strict";
import { test } from "node:test";
import { readChatGptResponse } from "./request.ts";
import { ChatGptAuthError } from "./errors.ts";

test("public GET retries a TLS reset and recovers without exposing the raw error", async () => {
  let calls = 0;
  const send: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, "GET");
    if (++calls === 1) throw new TypeError("secret-token", { cause: { code: "ECONNRESET" } });
    return Response.json({ ok: true });
  };
  const response = await readChatGptResponse(send, "https://auth.test/discovery", "discovery", {
    retryDelaysMs: [0, 0],
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("read retries are bounded and preserve a safe cause diagnostic", async () => {
  let calls = 0;
  await assert.rejects(
    readChatGptResponse(
      async () => {
        calls++;
        throw new TypeError("secret-token", { cause: { code: "ECONNRESET" } });
      },
      "https://auth.test/jwks",
      "jwks",
      { retryDelaysMs: [0, 0] },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ChatGptAuthError);
      assert.equal(error.code, "jwks_unavailable");
      assert.match(error.message, /ECONNRESET/);
      assert.doesNotMatch(error.message, /secret-token/);
      assert.ok(error.cause);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("terminal HTTP rejection is not retried; transient HTTP is bounded", async () => {
  for (const [status, expected] of [
    [401, 1],
    [403, 1],
    [503, 3],
  ] as const) {
    let calls = 0;
    const response = await readChatGptResponse(
      async () => {
        calls++;
        return new Response(null, { status });
      },
      "https://auth.test/models",
      "models",
      { retryDelaysMs: [0, 0] },
    );
    assert.equal(response.status, status);
    assert.equal(calls, expected);
  }
});

test("cancellation during backoff stops subsequent network attempts", async () => {
  const abort = new AbortController();
  let calls = 0;
  const promise = readChatGptResponse(
    async () => {
      calls++;
      queueMicrotask(() => abort.abort());
      throw new TypeError("fetch failed");
    },
    "https://auth.test/discovery",
    "discovery",
    { signal: abort.signal },
  );
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(calls, 1);
});
