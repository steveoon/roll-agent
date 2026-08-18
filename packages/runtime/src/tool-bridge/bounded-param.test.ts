import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedIntParam } from "./bounded-param.ts";
import { TOOL_OUTCOME_KINDS } from "./normalize-result.ts";

const spec = {
  name: "context",
  min: 0,
  max: 10,
  description: "每处命中前后附带的行数",
  defaultNote: "默认 0",
} as const;

test("schema describe 与校验范围同源派生", () => {
  const param = boundedIntParam(spec);
  const described = param.schema.description ?? "";
  assert.ok(described.includes("范围 0-10"));
  assert.ok(described.includes("默认 0"));
  assert.ok(described.includes("每处命中前后附带的行数"));
});

test("缺省与边界值通过校验", () => {
  const param = boundedIntParam(spec);
  assert.equal(param.check(undefined), undefined);
  assert.equal(param.check(0), undefined);
  assert.equal(param.check(10), undefined);
});

test("越界一句话说清参数、范围与所传值", () => {
  const param = boundedIntParam(spec);
  const rejected = param.check(18);
  assert.ok(rejected !== undefined);
  if (rejected === undefined) {
    return;
  }
  assert.equal(rejected.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  const message = String(rejected.display);
  assert.ok(message.includes("context"));
  assert.ok(message.includes("范围 0-10"));
  assert.ok(message.includes("18"));
});

test("非整数同样拒绝", () => {
  const param = boundedIntParam(spec);
  assert.ok(param.check(2.5) !== undefined);
});
