import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRecommendAgeStateText } from "./recommend-filter.ts";

describe("recommend filter helpers", () => {
  it("parses a bounded age range from filter row text", () => {
    assert.deepEqual(parseRecommendAgeStateText("年龄 20 40"), {
      ageMin: 20,
      ageMax: 40,
    });
  });

  it("parses an unlimited age range from filter row text", () => {
    assert.deepEqual(parseRecommendAgeStateText("年龄 16 不限"), {
      ageMin: 16,
    });
  });
});
