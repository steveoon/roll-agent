import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { z } from "zod";
import { StructuredToolError } from "@roll-agent/sdk";
import { BrowserExecuteInputSchema, BrowserSecurityConfigSchema } from "@roll-agent/browser";
import type { BrowserExecuteInput } from "@roll-agent/browser";
import { authorizeBrowserScript, browserExecutionDigest } from "./browser-script-approval.ts";
import { resetToolActionApprovalsForTests } from "./tool-action-approval.ts";

const binding = {
  browserInstance: "instance-one",
  documentId: "document-one",
  workflowKey: "workflow@v1",
};
const security = BrowserSecurityConfigSchema.parse({ actionPolicy: "confirm" });
const requestSchema = z.object({
  approvalRequest: z.object({
    id: z.string(),
    retryInput: z.object({ scriptApproval: z.object({ id: z.string() }) }),
  }),
});

function input(overrides: Partial<BrowserExecuteInput> = {}) {
  return BrowserExecuteInputSchema.parse({
    pageId: "page-one",
    source: 'await page.click(page.locator("button"));',
    args: { value: "one" },
    capabilities: ["read", "interact"],
    allowedOrigins: ["https://example.com"],
    ...overrides,
  });
}

function request(program = input()) {
  try {
    authorizeBrowserScript(program, binding, security);
    assert.fail("Expected approval request");
  } catch (error) {
    assert.ok(error instanceof StructuredToolError);
    assert.equal(error.payload.code, "needs_confirmation");
    return requestSchema.parse(error.payload.details).approvalRequest;
  }
}

afterEach(resetToolActionApprovalsForTests);

test("digest binds the complete program and browser/document/workflow identity", () => {
  const baseline = input();
  const digest = browserExecutionDigest(baseline, binding);
  const edits: Partial<BrowserExecuteInput>[] = [
    { source: 'await page.click(page.locator("other"));' },
    { args: { value: "two" } },
    { pageId: "page-two" },
    { allowedOrigins: ["https://other.example"] },
    { capabilities: ["read", "navigate"] },
    { timeoutMs: 29999 },
    { maxCalls: 99 },
    { preconditions: [{ target: { css: "form" }, state: "visible" }] },
    { postconditions: [{ target: { css: "done" }, state: "visible" }] },
  ];
  for (const edit of edits) assert.notEqual(browserExecutionDigest(input(edit), binding), digest);
  for (const edit of [
    { browserInstance: "instance-two" },
    { documentId: "document-two" },
    { workflowKey: "workflow@v2" },
  ]) {
    assert.notEqual(browserExecutionDigest(baseline, { ...binding, ...edit }), digest);
  }
  assert.equal(
    browserExecutionDigest(input({ capabilities: ["interact", "read", "read"] }), binding),
    digest,
  );
  assert.equal(browserExecutionDigest(input({ scriptApproval: { id: "token" } }), binding), digest);
});

test("exact approval retry input is consumable once and never replayable", () => {
  const approval = request();
  assert.equal(approval.id, approval.retryInput.scriptApproval.id);
  const approvedInput = input(approval.retryInput);
  assert.equal(authorizeBrowserScript(approvedInput, binding, security).approved, true);
  assert.throws(
    () => authorizeBrowserScript(approvedInput, binding, security),
    (error: unknown) =>
      error instanceof StructuredToolError && error.payload.code === "needs_confirmation",
  );
});

test("an approval cannot authorize edited arguments or a different document/version", () => {
  const approval = request();
  const token = approval.retryInput;
  for (const edit of [{ args: { value: "edited" } }, { source: "return 1;" }]) {
    assert.throws(
      () => authorizeBrowserScript(input({ ...token, ...edit }), binding, security),
      (error: unknown) =>
        error instanceof StructuredToolError && error.payload.code === "needs_confirmation",
    );
  }
  for (const edit of [
    { documentId: "new-document" },
    { workflowKey: "workflow@v2" },
    { browserInstance: "other-instance" },
  ]) {
    assert.throws(
      () => authorizeBrowserScript(input(token), { ...binding, ...edit }, security),
      (error: unknown) =>
        error instanceof StructuredToolError && error.payload.code === "needs_confirmation",
    );
  }
  assert.equal(authorizeBrowserScript(input(token), binding, security).approved, true);
});

test("log permits declared operations, deny blocks mutations but permits reads", () => {
  for (const policy of ["log", "deny"] as const) {
    const config = BrowserSecurityConfigSchema.parse({ actionPolicy: policy });
    assert.equal(
      authorizeBrowserScript(input({ capabilities: ["read"] }), binding, config).approved,
      false,
    );
    if (policy === "log") {
      assert.equal(authorizeBrowserScript(input(), binding, config).approved, false);
    } else {
      assert.throws(
        () => authorizeBrowserScript(input(), binding, config),
        (error: unknown) =>
          error instanceof StructuredToolError && error.payload.code === "action_denied",
      );
    }
  }
});

test("domain allowlist rejects declared origins before creating an approval", () => {
  const config = BrowserSecurityConfigSchema.parse({
    actionPolicy: "confirm",
    domainAllowlist: ["example.com"],
  });
  assert.throws(
    () =>
      authorizeBrowserScript(input({ allowedOrigins: ["https://other.example"] }), binding, config),
    (error: unknown) =>
      error instanceof StructuredToolError && error.payload.code === "action_denied",
  );
});
