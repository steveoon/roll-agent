import assert from "node:assert/strict";
import test from "node:test";
import { formatRunToolResultForJsonOutput } from "./run.ts";

test("roll run JSON preserves the browser script approval request and exact retry field", () => {
  const payload = {
    code: "needs_confirmation",
    message: "Confirm this exact browser script before execution",
    details: {
      executionDigest: "a".repeat(64),
      pageId: "page-one",
      browserInstance: "instance-one",
      capabilities: ["read", "interact"],
      allowedOrigins: ["https://example.com"],
      approvalRequest: {
        id: "approval-one",
        expiresAt: "2026-09-10T12:00:00.000Z",
        tool: "browser_execute",
        target: "instance-one:page-one",
        retryInput: { scriptApproval: { id: "approval-one" } },
      },
    },
  };
  const result = formatRunToolResultForJsonOutput({
    index: 0,
    agent: "browser-use-agent",
    tool: "browser_execute",
    ok: false,
    error: "tool returned isError=true",
    result: { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] },
  });
  assert.deepEqual(result.result, payload);
  assert.equal(result.ok, false);
  assert.ok(JSON.stringify(result).includes('"scriptApproval":{"id":"approval-one"}'));
  assert.ok(!JSON.stringify(result).includes("toolActionApproval"));
});

test("roll run JSON retains cancelled execution and already-executed action evidence", () => {
  const payload = {
    executionId: "execution-one",
    status: "cancelled",
    verification: "not_requested",
    actions: [
      { index: 0, method: "click", executed: true, verification: "not_requested", elapsedMs: 1 },
    ],
    error: { code: "cancelled", message: "Completed actions were not rolled back" },
  };
  const result = formatRunToolResultForJsonOutput({
    index: 0,
    agent: "browser-use-agent",
    tool: "browser_execute",
    ok: true,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });
  assert.deepEqual(result.result, payload);
});
