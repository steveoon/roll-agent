import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillInvocationResult, SKILL_INVOCATION_PARSE_KINDS } from "./invocation.ts";

const SKILLS = [{ name: "typescript-magician", description: "类型魔法师", source: "user" }];

test("路径形状的首 token 不进入 skill 前缀扫描", () => {
  const result = parseSkillInvocationResult(
    "/Users/gt/yc/supplier2.0/AGENTS.md 依据规则审核",
    SKILLS,
  );
  assert.equal(result.kind, SKILL_INVOCATION_PARSE_KINDS.none);
});

test("skill 前缀后的路径 token 归入 prompt 而非未知 skill", () => {
  const result = parseSkillInvocationResult("/typescript-magician /Users/gt/x.md 审核", SKILLS);
  assert.equal(result.kind, SKILL_INVOCATION_PARSE_KINDS.valid);
  if (result.kind === SKILL_INVOCATION_PARSE_KINDS.valid) {
    assert.deepEqual(
      result.invocation.skills.map((skill) => skill.name),
      ["typescript-magician"],
    );
    assert.equal(result.invocation.prompt, "/Users/gt/x.md 审核");
  }
});

test("命令形状的未知 token 仍返回 unknown", () => {
  const result = parseSkillInvocationResult("/nope 做某事", SKILLS);
  assert.equal(result.kind, SKILL_INVOCATION_PARSE_KINDS.unknown);
});

test("含非命令字符的首 token 按普通文本处理", () => {
  const result = parseSkillInvocationResult("/AGENTS.md 审核", SKILLS);
  assert.equal(result.kind, SKILL_INVOCATION_PARSE_KINDS.none);
});
