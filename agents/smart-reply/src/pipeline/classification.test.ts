import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeGeneratedTurnPlanOutput,
  sanitizePlan,
  selectContextNeeds,
  selectPrimaryNeed,
} from "./classification.ts";
import { TurnPlanSchema, type TurnPlan } from "../types/reply-policy.ts";

function makePlan(overrides?: Partial<TurnPlan>): TurnPlan {
  return {
    stage: "job_consultation",
    subGoals: ["回答问题", "推进下一步", "多余目标"],
    needs: ["salary", "schedule"],
    primaryNeed: "none",
    riskFlags: [],
    confidence: 0.8,
    extractedInfo: {
      mentionedBrand: null,
      city: "佛山",
      mentionedLocations: null,
      mentionedDistricts: null,
      specificAge: null,
      hasUrgency: null,
      preferredSchedule: null,
    },
    reasoningText: "test",
    ...overrides,
  };
}

describe("selectPrimaryNeed", () => {
  it("uses the current message's strongest need when the planned primary need is invalid", () => {
    const result = selectPrimaryNeed("wechat", ["salary", "schedule"], "这个岗位薪资多少钱");
    assert.equal(result, "salary");
  });

  it("falls back to merged needs priority when the current message has no direct need", () => {
    const result = selectPrimaryNeed(undefined, ["availability", "requirements"], "可以继续聊");
    assert.equal(result, "requirements");
  });
});

describe("sanitizePlan", () => {
  it("clamps subGoals and computes a valid primaryNeed", () => {
    const plan = makePlan({ primaryNeed: "none", needs: ["schedule", "none"] });
    const sanitized = sanitizePlan(plan, new Set(["schedule"]), "一天工作多少个小时");

    assert.deepEqual(sanitized.subGoals, ["回答问题", "推进下一步"]);
    assert.deepEqual(sanitized.needs, ["schedule"]);
    assert.equal(sanitized.primaryNeed, "schedule");
  });
});

describe("normalizeGeneratedTurnPlanOutput", () => {
  it("clips Anthropic-compatible array fields back to the internal schema limits", () => {
    const normalized = normalizeGeneratedTurnPlanOutput(
      makePlan({
        subGoals: ["1", "2", "3"],
        needs: [
          "salary",
          "schedule",
          "location",
          "stores",
          "policy",
          "availability",
          "requirements",
          "interview",
          "wechat",
        ],
        riskFlags: [
          "insurance_promise_risk",
          "age_sensitive",
          "confrontation_emotion",
          "urgency_high",
          "qualification_mismatch",
          "age_sensitive",
          "urgency_high",
        ],
        extractedInfo: {
          mentionedBrand: null,
          city: "佛山",
          mentionedLocations: null,
          mentionedDistricts: Array.from({ length: 12 }, (_, index) => ({
            district: `区${index + 1}`,
            confidence: 0.8,
          })),
          specificAge: null,
          hasUrgency: null,
          preferredSchedule: null,
        },
      }),
    );

    const parsed = TurnPlanSchema.safeParse(normalized);

    assert.equal(parsed.success, true);
    if (!parsed.success) return;

    assert.equal(parsed.data.subGoals.length, 2);
    assert.equal(parsed.data.needs.length, 8);
    assert.equal(parsed.data.riskFlags.length, 6);
    assert.equal(parsed.data.extractedInfo.mentionedDistricts?.length, 10);
  });
});

describe("selectContextNeeds", () => {
  it("keeps the primary need and allows one explicit secondary need", () => {
    const needs = selectContextNeeds("salary", ["salary", "location", "schedule"], "工资多少？门店在哪里？", 2);
    assert.deepEqual(needs, ["salary", "location"]);
  });

  it("does not re-introduce a need that the turn plan already excluded", () => {
    const needs = selectContextNeeds("schedule", ["schedule"], "工资随便，主要看排班", 2);
    assert.deepEqual(needs, ["schedule"]);
  });
});
