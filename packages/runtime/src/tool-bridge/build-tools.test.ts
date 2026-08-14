import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionApprovalMemory } from "../approval/approval-memory.ts";
import { gateToolCall, type ApprovalRequest, type ToolBridgeContext } from "./build-tools.ts";

function confirmPolicyCtx(
  memory: SessionApprovalMemory | undefined,
  decisions: Array<{ approved: boolean; scope?: "once" | "session" }>,
) {
  const approvals: ApprovalRequest[] = [];
  const ctx: ToolBridgeContext = {
    policy: { check: () => ({ action: "confirm", reason: "测试" }) },
    requestApproval: (request) => {
      approvals.push(request);
      const next = decisions.shift();
      return Promise.resolve(next ?? { approved: false });
    },
    ...(memory ? { approvalMemory: memory } : {}),
  };
  return { ctx, approvals };
}

test("记忆命中时跳过 requestApproval", async () => {
  const memory = new SessionApprovalMemory();
  memory.grant("edit_file:workdir");
  const { ctx, approvals } = confirmPolicyCtx(memory, []);
  const result = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(result, undefined);
  assert.equal(approvals.length, 0);
});

test("scope=session 的批准写入记忆，后续调用免确认", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx, approvals } = confirmPolicyCtx(memory, [{ approved: true, scope: "session" }]);
  const first = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(first, undefined);
  assert.equal(approvals.length, 1);
  const second = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(second, undefined);
  assert.equal(approvals.length, 1);
});

test("scope 缺省的批准不写记忆，下次仍确认", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx, approvals } = confirmPolicyCtx(memory, [{ approved: true }, { approved: true }]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  assert.equal(approvals.length, 2);
});

test("无 memoryKey 或无 memory 时行为与既有一致", async () => {
  const { ctx, approvals } = confirmPolicyCtx(undefined, [{ approved: true, scope: "session" }]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {});
  assert.equal(approvals.length, 1);
});

test("拒绝不写记忆", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx } = confirmPolicyCtx(memory, [{ approved: false, scope: "session" }]);
  const result = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  assert.ok(result !== undefined);
  assert.equal(memory.isGranted("k"), false);
});
