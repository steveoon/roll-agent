import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionApprovalMemory } from "./approval-memory.ts";

test("未授权的 key 返回 false，grant 后返回 true", () => {
  const memory = new SessionApprovalMemory();
  assert.equal(memory.isGranted("edit_file:workdir"), false);
  memory.grant("edit_file:workdir");
  assert.equal(memory.isGranted("edit_file:workdir"), true);
  assert.equal(memory.isGranted("write_file:workdir"), false);
});
