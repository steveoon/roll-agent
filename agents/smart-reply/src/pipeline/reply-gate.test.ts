import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countQuestions, validateReply } from "./reply-gate.ts";
import { DEFAULT_REPLY_POLICY } from "../types/reply-policy.ts";

describe("validateReply", () => {
  it("flags too many questions and audit tone in minimal mode", () => {
    const result = validateReply({
      text: "可以的，你现在在哪个区？什么时候能到岗？另外确认下你是否符合基本入职要求？",
      turnIndex: 1,
      mode: "minimal",
      primaryNeed: "none",
      policy: DEFAULT_REPLY_POLICY,
    });

    assert.ok(result.violations.includes("too_many_questions"));
    assert.ok(result.violations.includes("audit_tone"));
  });

  it("flags first-turn specific numeric disclosure", () => {
    const result = validateReply({
      text: "这个岗位时薪22元/时，班次是09:00~14:00，你看可以吗？",
      turnIndex: 1,
      mode: "minimal",
      primaryNeed: "salary",
      policy: DEFAULT_REPLY_POLICY,
    });

    assert.ok(result.violations.includes("premature_numeric_disclosure"));
  });

  it("flags overpacked replies when multiple overload signals appear", () => {
    const result = validateReply({
      text: "1. 时薪22元/时 2. 班次09:00~14:00 3. 门店在万达广场，你现在在哪个区？什么时候能到岗？",
      turnIndex: 2,
      mode: "focused",
      primaryNeed: "salary",
      policy: DEFAULT_REPLY_POLICY,
    });

    assert.ok(result.violations.includes("reply_overpacked"));
  });

  it("allows a focused single-axis reply", () => {
    const result = validateReply({
      text: "这个岗位目前是时薪 22 元/时，具体排班我再按你的时间帮你确认。",
      turnIndex: 2,
      mode: "focused",
      primaryNeed: "salary",
      policy: DEFAULT_REPLY_POLICY,
    });

    assert.deepEqual(result.violations, []);
  });

  it("allows a focused dual-axis reply when a secondary need is explicitly permitted", () => {
    const result = validateReply({
      text: "这个岗位目前时薪 22 元/时，门店在南海区桂澜路万达广场这边。",
      turnIndex: 2,
      mode: "focused",
      primaryNeed: "salary",
      allowedNeeds: ["salary", "location"],
      policy: DEFAULT_REPLY_POLICY,
    });

    assert.deepEqual(result.violations, []);
  });

  it("does not treat a generic salary handoff as a concrete off-axis fact", () => {
    const result = validateReply({
      text: "薪资我这边再按门店帮你确认，先看看排班是不是合适。",
      turnIndex: 2,
      mode: "focused",
      primaryNeed: "schedule",
      policy: DEFAULT_REPLY_POLICY,
    });

    assert.ok(!result.violations.includes("off_axis_fact_disclosure"));
  });
});

describe("countQuestions", () => {
  it("counts mixed punctuation and modal questions without double counting", () => {
    assert.equal(countQuestions("你在哪个区？另外你能接受排班吗"), 2);
    assert.equal(countQuestions("你在哪呢？"), 1);
  });
});
