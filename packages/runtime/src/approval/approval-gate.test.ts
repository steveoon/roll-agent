import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalGate } from "./approval-gate.ts";

test("ApprovalGate resolve 决议并清理", async () => {
  const gate = new ApprovalGate();
  const pending = gate.request("a1");
  assert.equal(gate.pendingCount, 1);
  assert.equal(gate.resolve("a1", { approved: true }), true);
  assert.deepEqual(await pending, { approved: true });
  assert.equal(gate.pendingCount, 0);
});

test("ApprovalGate resolve 未知 id 返回 false", () => {
  const gate = new ApprovalGate();
  assert.equal(gate.resolve("nope", { approved: true }), false);
});

test("ApprovalGate abortAll 拒绝所有挂起", async () => {
  const gate = new ApprovalGate();
  const first = gate.request("a1");
  const second = gate.request("a2");
  gate.abortAll();
  assert.deepEqual(await first, { approved: false, reason: "aborted" });
  assert.deepEqual(await second, { approved: false, reason: "aborted" });
  assert.equal(gate.pendingCount, 0);
});
