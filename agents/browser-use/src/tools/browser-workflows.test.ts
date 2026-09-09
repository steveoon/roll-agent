import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import type { BrowserExecuteResult } from "@roll-agent/browser";
import { WorkflowStore } from "../workflows/store.ts";
import { resetToolActionApprovalsForTests } from "../tool-action-approval.ts";
import {
  browserWorkflowList,
  browserWorkflowSaveDraft,
  browserWorkflowValidate,
  browserWorkflowSetStatus,
  browserWorkflowRun,
  BrowserWorkflowExecutionInputSchema,
  setBrowserWorkflowDepsForTests,
} from "./browser-workflows.ts";

const ctx: AgentContext = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  llm: { generateText: async () => "" },
};
const draft = {
  id: "search",
  name: "Search",
  description: "Read search results",
  source: "return await page.read({css:'h1'});",
  appliesTo: { origins: ["https://example.com"], pathPrefix: "/search" },
  allowedOrigins: ["https://example.com"],
  capabilities: ["read"] as const,
  parameterSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  preconditions: [],
  postconditions: [{ target: { css: "h1" }, state: "visible" }],
  notes: "",
  locatorExplanations: [],
};
const completed: BrowserExecuteResult = {
  executionId: "run-1",
  status: "completed",
  verification: "passed",
  value: "runtime-private-output",
  logs: [],
  actions: [],
  checks: [{ passed: true, kind: "visible", elapsedMs: 1 }],
  observation: { changed: false },
  artifacts: [],
  metrics: { elapsedMs: 1, helperCalls: 1, verifiedAssertions: 1 },
};
function errorCode(expected: string) {
  return (error: unknown) =>
    error instanceof StructuredToolError && error.payload.code === expected;
}
function approvalId(error: unknown): string {
  assert.ok(error instanceof StructuredToolError);
  assert.equal(error.payload.code, "needs_confirmation");
  const parsed = error.payload.details as { approvalRequest: { id: string } };
  return parsed.approvalRequest.id;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "roll-workflow-tools-"));
  const store = new WorkflowStore({ root });
  let executionCalls = 0;
  let result = completed;
  let beforeExecute: (() => Promise<void>) | undefined;
  let pageUrl = "https://example.com/search";
  resetToolActionApprovalsForTests();
  setBrowserWorkflowDepsForTests({
    store,
    compile: async () => ({ valid: true }),
    readPageUrl: async () => pageUrl,
    execute: async (input, _ctx, options) => {
      executionCalls++;
      assert.equal(input.source, draft.source);
      assert.ok(options?.workflowKey?.startsWith("search:"));
      if (beforeExecute) await beforeExecute();
      await options?.beforeAction?.();
      return { result, executionDigest: "a".repeat(64) };
    },
  });
  t.after(async () => {
    setBrowserWorkflowDepsForTests();
    resetToolActionApprovalsForTests();
    await rm(root, { recursive: true, force: true });
  });
  const saved = await browserWorkflowSaveDraft.execute(
    { draft: { ...draft, capabilities: [...draft.capabilities] } },
    ctx,
  );
  const input = {
    id: draft.id,
    version: saved.version,
    pageId: "page-1",
    args: { query: "runtime-private-query" },
  };
  const activate = async () => {
    let token = "";
    await assert.rejects(
      browserWorkflowSetStatus.execute(
        { id: input.id, version: input.version, status: "active" },
        ctx,
      ),
      (error) => {
        token = approvalId(error);
        return true;
      },
    );
    return await browserWorkflowSetStatus.execute(
      { id: input.id, version: input.version, status: "active", toolActionApproval: { id: token } },
      ctx,
    );
  };
  return {
    root,
    store,
    input,
    saved,
    activate,
    executionCalls: () => executionCalls,
    setResult: (next: BrowserExecuteResult) => {
      result = next;
    },
    setBeforeExecute: (next: () => Promise<void>) => {
      beforeExecute = next;
    },
    setPageUrl: (next: string) => {
      pageUrl = next;
    },
  };
}

test("save and successful validation do not autoactivate or persist execution data", async (t) => {
  const f = await fixture(t);
  assert.equal(f.saved.status, "draft");
  assert.equal(f.executionCalls(), 0);
  await assert.rejects(browserWorkflowRun.execute(f.input, ctx), errorCode("workflow_inactive"));
  await assert.rejects(
    browserWorkflowSetStatus.execute(
      { id: f.input.id, version: f.input.version, status: "active" },
      ctx,
    ),
    errorCode("workflow_unvalidated"),
  );
  const validation = await browserWorkflowValidate.execute(f.input, ctx);
  assert.equal(validation.validationRecorded, true);
  assert.equal(validation.workflow.status, "draft");
  assert.equal((await f.activate()).status, "active");
  assert.equal(
    (await browserWorkflowList.execute({ url: "https://example.com/search" }, ctx)).workflows
      .length,
    1,
  );
  for (const file of await readdir(join(f.root, draft.id))) {
    assert.doesNotMatch(await readFile(join(f.root, draft.id, file), "utf8"), /runtime-private/);
  }
  assert.throws(() =>
    BrowserWorkflowExecutionInputSchema.parse({ ...f.input, validationReceipt: { success: true } }),
  );
});

test("activation token is bound to version and single-use", async (t) => {
  const f = await fixture(t);
  await browserWorkflowValidate.execute(f.input, ctx);
  let token = "";
  await assert.rejects(
    browserWorkflowSetStatus.execute(
      { id: f.input.id, version: f.input.version, status: "active" },
      ctx,
    ),
    (error) => {
      token = approvalId(error);
      return true;
    },
  );
  const second = await f.store.saveDraft({
    ...draft,
    capabilities: [...draft.capabilities],
    source: "return 2;",
  });
  await f.store.recordValidation(draft.id, second.version, {
    compiled: true,
    success: true,
    verifiedAssertions: 1,
    executionDigest: "b".repeat(64),
  });
  await assert.rejects(
    browserWorkflowSetStatus.execute(
      {
        id: draft.id,
        version: second.version,
        status: "active",
        toolActionApproval: { id: token },
      },
      ctx,
    ),
    errorCode("needs_confirmation"),
  );
  assert.equal((await f.store.getVersion(draft.id, second.version)).state.status, "draft");
  const approved = {
    id: f.input.id,
    version: f.input.version,
    status: "active" as const,
    toolActionApproval: { id: token },
  };
  await browserWorkflowSetStatus.execute(approved, ctx);
  await assert.rejects(
    browserWorkflowSetStatus.execute(approved, ctx),
    errorCode("needs_confirmation"),
  );
});

test("run enforces live applicability and parameters before execution", async (t) => {
  const f = await fixture(t);
  await browserWorkflowValidate.execute(f.input, ctx);
  await f.activate();
  const calls = f.executionCalls();
  f.setPageUrl("https://example.com/account");
  await assert.rejects(
    browserWorkflowRun.execute(f.input, ctx),
    errorCode("workflow_not_applicable"),
  );
  f.setPageUrl("https://example.com/search");
  await assert.rejects(browserWorkflowRun.execute({ ...f.input, args: { query: 4 } }, ctx));
  assert.equal(f.executionCalls(), calls);
});

test("disabled workflow stops in-flight helper and lookup immediately", async (t) => {
  const f = await fixture(t);
  await browserWorkflowValidate.execute(f.input, ctx);
  await f.activate();
  f.setBeforeExecute(async () => {
    await browserWorkflowSetStatus.execute(
      { id: f.input.id, version: f.input.version, status: "disabled" },
      ctx,
    );
  });
  await assert.rejects(browserWorkflowRun.execute(f.input, ctx), errorCode("workflow_inactive"));
  assert.deepEqual(
    (await browserWorkflowList.execute({ url: "https://example.com/search" }, ctx)).workflows,
    [],
  );
});

test("verification failure suspends recommendation; cancellation and policy do not", async (t) => {
  const f = await fixture(t);
  await browserWorkflowValidate.execute(f.input, ctx);
  await f.activate();
  f.setResult({
    ...completed,
    status: "failed",
    verification: "failed",
    error: { code: "verification_failed", message: "Expected state absent" },
  });
  const failed = await browserWorkflowRun.execute(f.input, ctx);
  assert.equal(failed.needsReexploration, true);
  assert.equal(failed.workflow.status, "suspended");
  await f.activate();
  f.setResult({
    ...completed,
    status: "cancelled",
    error: { code: "cancelled", message: "cancelled" },
  });
  assert.equal((await browserWorkflowRun.execute(f.input, ctx)).workflow.status, "active");
  f.setResult({
    ...completed,
    status: "failed",
    error: { code: "action_denied", message: "denied" },
  });
  assert.equal((await browserWorkflowRun.execute(f.input, ctx)).needsReexploration, false);
});

test("unverified completion never creates an activation receipt", async (t) => {
  const f = await fixture(t);
  f.setResult({
    ...completed,
    verification: "not_requested",
    checks: [],
    metrics: { ...completed.metrics, verifiedAssertions: 0 },
  });
  const result = await browserWorkflowValidate.execute(f.input, ctx);
  assert.equal(result.validationRecorded, false);
  assert.equal((await f.store.getVersion(f.input.id, f.input.version)).state.validations.length, 0);
  await assert.rejects(
    browserWorkflowSetStatus.execute(
      { id: f.input.id, version: f.input.version, status: "active" },
      ctx,
    ),
    errorCode("workflow_unvalidated"),
  );
});
