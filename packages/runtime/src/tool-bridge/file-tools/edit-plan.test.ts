import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdits } from "./edit-plan.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("planEdits 顺序应用多条编辑并记录位置", () => {
  const plan = planEdits("alpha beta gamma\n", [
    { old_string: "alpha", new_string: "A" },
    { old_string: "gamma", new_string: "GAMMA" },
  ]);
  assert.ok(plan.ok);
  assert.equal(plan.next, "A beta GAMMA\n");
  assert.deepEqual(plan.applied, [
    { position: 0, length: 1 },
    { position: 7, length: 5 },
  ]);
});

test("planEdits 在 CRLF 文件上适配行尾", () => {
  const plan = planEdits("first\r\nsecond\r\n", [
    { old_string: "first\nsecond", new_string: "first\nchanged" },
  ]);
  assert.ok(plan.ok);
  assert.equal(plan.next, "first\r\nchanged\r\n");
});

test("planEdits 无匹配返回 tool_failed 且不产出 next", () => {
  const plan = planEdits("alpha\nbeta", [{ old_string: "不存在", new_string: "x" }]);
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(plan.result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
    assert.match(String(plan.result.display), /roll__write_file 整文件重写/u);
  }
});

test("planEdits 内容无变化返回 invalid_input", () => {
  const plan = planEdits("alpha beta\n", [
    { old_string: "alpha", new_string: "gamma" },
    { old_string: "gamma", new_string: "alpha" },
  ]);
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(plan.result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
    assert.match(String(plan.result.display), /与原文件完全相同/u);
  }
});

test("planEdits replace_all 替换全部并记录每处位置", () => {
  const plan = planEdits("x-x-x", [{ old_string: "x", new_string: "yy", replace_all: true }]);
  assert.ok(plan.ok);
  assert.equal(plan.next, "yy-yy-yy");
  assert.equal(plan.applied.length, 3);
});
