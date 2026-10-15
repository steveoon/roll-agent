import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticError } from "./compaction-diagnostics.mjs";

test("provider diagnostics preserve cause but redact short credentials and exclude bodies", () => {
  const cause = new Error('server_is_overloaded; access_token="short-secret"');
  cause.code = "server_is_overloaded";
  const error = new Error("Stream failed. Authorization: Bearer short-secret", { cause });
  error.responseBody = "private-response";
  error.responseHeaders = { cookie: "session=secret" };
  const result = diagnosticError(error);
  assert.equal(result.cause.code, "server_is_overloaded");
  assert.match(result.cause.message, /server_is_overloaded/u);
  assert.doesNotMatch(JSON.stringify(result), /short-secret|private-response|session=secret/u);
});

test("cyclic causes and non-error rejections stay bounded", () => {
  const error = new Error("stream ended");
  error.cause = error;
  assert.ok(JSON.stringify(diagnosticError(error)).length < 1000);
  assert.deepEqual(diagnosticError("upstream disconnected"), { message: "upstream disconnected" });
});

test("nested SDK and auth wrappers retain the underlying transport code", () => {
  const transport = Object.assign(new Error("TLS connection reset"), { code: "ECONNRESET" });
  const fetch = new TypeError("fetch failed", { cause: transport });
  const auth = new Error("network_error", { cause: fetch });
  const sdk = new Error("API call failed", { cause: auth });
  assert.equal(diagnosticError(sdk).cause.cause.cause.code, "ECONNRESET");
});
