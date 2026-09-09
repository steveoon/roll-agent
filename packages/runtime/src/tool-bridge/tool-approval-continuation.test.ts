import assert from "node:assert/strict";
import test from "node:test";
import { executeWithToolApproval } from "./tool-approval-continuation.ts";
import type { ApprovalRequest, ToolBridgeContext } from "./build-tools.ts";
import type { AgentTool } from "@roll-agent/core/types/agent";

const agentTool: AgentTool = {
  name: "execute_program",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["source", "args"],
    properties: {
      source: { type: "string" },
      args: { type: "object" },
      scriptApproval: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      toolActionApproval: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
};

function challenge(details: Record<string, unknown> = {}) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "needs_confirmation",
          details: {
            executionState: "not_executed",
            approvalRequest: {
              id: "token-one",
              tool: "execute_program",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              retryInput: { scriptApproval: { id: "token-one" } },
            },
            ...details,
          },
        }),
      },
    ],
  };
}

const success = { content: [{ type: "text", text: '{"done":true}' }] };

function fixture(
  options: {
    first?: unknown;
    second?: unknown;
    ctx?: Partial<ToolBridgeContext>;
    signal?: AbortSignal;
    listedTool?: AgentTool;
  } = {},
) {
  const calls: Record<string, unknown>[] = [];
  const approvals: ApprovalRequest[] = [];
  const input = { source: "original source", args: { value: "original value" } };
  const ctx: ToolBridgeContext = {
    policy: { check: () => ({ action: "allow" }) },
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
    ...options.ctx,
  };
  const run = () =>
    executeWithToolApproval({
      input,
      agentName: "test-agent",
      agentTool: options.listedTool ?? agentTool,
      annotations: undefined,
      ctx,
      signal: options.signal,
      call: async (args) => {
        calls.push(structuredClone(args));
        return calls.length === 1 ? (options.first ?? challenge()) : (options.second ?? success);
      },
    });
  return { run, calls, approvals, input };
}

test("explicit pre-effect challenge requests once and retries only with its credential", async () => {
  const target = fixture();
  const result = await target.run();
  assert.equal(result.outcome.kind, "success");
  assert.equal(target.approvals.length, 1);
  assert.deepEqual(target.approvals[0]?.input, target.input);
  assert.equal(target.approvals[0]?.sessionGrantLabel, undefined);
  assert.deepEqual(target.calls, [
    target.input,
    { ...target.input, scriptApproval: { id: "token-one" } },
  ]);
});

test("rejection never retries and session approval scope is not remembered", async () => {
  const target = fixture({
    ctx: { requestApproval: async () => ({ approved: false, scope: "session" }) },
  });
  assert.equal((await target.run()).outcome.kind, "user_rejected");
  assert.equal(target.calls.length, 1);
});

test("unmarked, partially executed and malformed responses never prompt or replay", async () => {
  for (const first of [
    challenge({ executionState: undefined }),
    challenge({ executionState: "partially_executed" }),
    { isError: false, content: challenge().content },
    { isError: true, content: [{ type: "text", text: "not JSON" }] },
    { isError: true, content: [...challenge().content, { type: "text", text: "other output" }] },
  ]) {
    const target = fixture({ first });
    await target.run();
    assert.equal(target.calls.length, 1);
    assert.equal(target.approvals.length, 0);
  }
});

test("malicious retry arguments, mismatched tokens/tools and expired credentials are ignored", async () => {
  const base = {
    id: "token-one",
    tool: "execute_program",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    retryInput: { scriptApproval: { id: "token-one" } },
  };
  for (const approvalRequest of [
    { ...base, tool: "another_tool" },
    { ...base, retryInput: { scriptApproval: { id: "other-token" } } },
    { ...base, retryInput: { scriptApproval: { id: "token-one" }, source: "replacement source" } },
    { ...base, retryInput: { args: { dangerous: true } } },
    { ...base, retryInput: { scriptApproval: { id: "token-one", extra: "field" } } },
    { ...base, expiresAt: new Date(0).toISOString() },
  ]) {
    const target = fixture({ first: challenge({ approvalRequest }) });
    await target.run();
    assert.equal(target.calls.length, 1);
    assert.equal(target.approvals.length, 0);
  }
});

test("preflight prevents adding a credential field absent from the actual tool schema", async () => {
  const target = fixture({
    listedTool: {
      ...agentTool,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { source: { type: "string" }, args: { type: "object" } },
      },
    },
  });
  await target.run();
  assert.equal(target.calls.length, 1);
  assert.equal(target.approvals.length, 0);
});

test("a second challenge or partial error is returned without another prompt or retry", async () => {
  for (const second of [
    challenge(),
    {
      isError: true,
      content: [{ type: "text", text: '{"status":"failed","actions":[{"executed":true}]}' }],
    },
  ]) {
    const target = fixture({ second });
    assert.equal((await target.run()).outcome.kind, "tool_failed");
    assert.equal(target.calls.length, 2);
    assert.equal(target.approvals.length, 1);
  }
});

test("approval preview mutation cannot modify the original program that is retried", async () => {
  const target = fixture({
    ctx: {
      requestApproval: async (request) => {
        request.input["source"] = "changed";
        const args = request.input["args"];
        if (typeof args === "object" && args !== null && "value" in args) args.value = "changed";
        return { approved: true };
      },
    },
  });
  await target.run();
  assert.deepEqual(target.calls[1], {
    source: "original source",
    args: { value: "original value" },
    scriptApproval: { id: "token-one" },
  });
});

test("live policy denial after approval prevents the retry", async () => {
  const target = fixture({ ctx: { policy: { check: () => ({ action: "deny" }) } } });
  assert.equal((await target.run()).outcome.kind, "policy_denied");
  assert.equal(target.calls.length, 1);
});

test("cancellation while waiting releases the wait and late approval never retries", async () => {
  const abort = new AbortController();
  let enter: () => void = () => {};
  let approve: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const target = fixture({
    signal: abort.signal,
    ctx: {
      requestApproval: async () => {
        enter();
        return new Promise((resolve) => {
          approve = () => resolve({ approved: true });
        });
      },
    },
  });
  const running = target.run();
  await entered;
  abort.abort();
  const result = await running;
  assert.equal(result.outcome.kind, "cancelled");
  assert.ok("executionState" in result.outcome && result.outcome.executionState === "not_executed");
  approve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(target.calls.length, 1);
});

test("toolActionApproval supports the same generic one-time continuation", async () => {
  const target = fixture({
    first: challenge({
      approvalRequest: {
        id: "token-one",
        tool: "execute_program",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        retryInput: { toolActionApproval: { id: "token-one" } },
      },
    }),
  });
  assert.equal((await target.run()).outcome.kind, "success");
  assert.deepEqual(target.calls[1], { ...target.input, toolActionApproval: { id: "token-one" } });
});
