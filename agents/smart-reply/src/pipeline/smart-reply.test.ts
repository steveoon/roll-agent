import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasUnsupportedFactClaims,
  resolveEffectiveDisclosureMode,
  resolveTurnIndex,
} from "./smart-reply.ts";

describe("resolveTurnIndex", () => {
  it("prefers explicit turn index", () => {
    assert.equal(resolveTurnIndex([], 3), 3);
  });

  it("falls back to first turn when there is no history", () => {
    assert.equal(resolveTurnIndex([], undefined), 1);
  });

  it("falls back to a non-first turn when history exists", () => {
    assert.equal(resolveTurnIndex(["候选人：你好"], undefined), 2);
  });
});

describe("resolveEffectiveDisclosureMode", () => {
  it("forces minimal mode for first turn", () => {
    assert.equal(resolveEffectiveDisclosureMode(1, "job_consultation"), "minimal");
  });

  it("allows qualify stage to use focused mode after the first turn", () => {
    assert.equal(resolveEffectiveDisclosureMode(2, "qualify_candidate"), "focused");
  });

  it("uses focused mode for later job consultation turns", () => {
    assert.equal(resolveEffectiveDisclosureMode(2, "job_consultation"), "focused");
  });
});

describe("hasUnsupportedFactClaims", () => {
  it("flags claims whose fact family is not present in the current context", () => {
    const unsupported = hasUnsupportedFactClaims(
      "这个岗位时薪 22 元/时，班次是 09:00~14:00。",
      "匹配到的门店信息：\n• 某门店\n  排班：灵活排班\n  时间：09:00~14:00\n",
      ["schedule"],
    );

    assert.equal(unsupported, true);
  });

  it("allows claims when the fact family exists in both allowed needs and context", () => {
    const unsupported = hasUnsupportedFactClaims(
      "这个岗位时薪 22 元/时。",
      "匹配到的门店信息：\n• 某门店\n  职位：服务员\n  薪资：22元/时\n",
      ["salary"],
    );

    assert.equal(unsupported, false);
  });
});
