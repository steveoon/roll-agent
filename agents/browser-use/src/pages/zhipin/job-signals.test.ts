import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveConversationSignals,
  resolveExpectedSignals,
  resolvePreferredBrand,
} from "./job-signals.ts";

describe("job-signals", () => {
  it("keeps generic communication positions unbranded while parsing expected signals", () => {
    const result = resolveConversationSignals({
      communicationPosition: "餐饮兼职服务员",
      expectedJobText: "上海 · 服务员",
    });

    assert.deepEqual(result, {
      communicationPosition: "餐饮兼职服务员",
      expectedLocation: "上海",
      expectedPosition: "服务员",
    });
  });

  it("extracts preferredBrand only from recognized explicit brand prefixes", () => {
    assert.equal(resolvePreferredBrand("肯德基-服务员"), "肯德基");
    assert.equal(resolvePreferredBrand("麦当劳 服务员"), "麦当劳");
    assert.equal(resolvePreferredBrand("餐饮兼职服务员"), undefined);
    assert.equal(resolvePreferredBrand("阳志园"), undefined);
  });

  it("returns empty expected signals when recent-focus text is absent", () => {
    assert.deepEqual(resolveExpectedSignals(""), {
      expectedLocation: "",
      expectedPosition: "",
    });
  });
});
