import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PreparedReplyVariantDecisionSchema } from "./prepared-reply-decision.ts";

describe("PreparedReplyVariantDecisionSchema", () => {
  it("normalizes meaningful reason and Judge provenance", () => {
    const parsed = PreparedReplyVariantDecisionSchema.parse({
      chosenOption: "option_2",
      reason: "  option_2 更直接回应候选人的薪资问题  ",
      confirmedFindingCodes: [],
      judgeModel: "  mcp-sampling  ",
    });

    assert.equal(parsed.reason, "option_2 更直接回应候选人的薪资问题");
    assert.equal(parsed.judgeModel, "mcp-sampling");
  });

  it("rejects a whitespace-only decision reason", () => {
    assert.equal(
      PreparedReplyVariantDecisionSchema.safeParse({
        chosenOption: "option_1",
        reason: "   ",
        confirmedFindingCodes: [],
      }).success,
      false,
    );
  });
});
