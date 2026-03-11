import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asConfidence } from "./router.ts";

describe("asConfidence", () => {
  it("should accept 0", () => {
    const c = asConfidence(0);
    assert.equal(c, 0);
  });

  it("should accept 1", () => {
    const c = asConfidence(1);
    assert.equal(c, 1);
  });

  it("should accept 0.5", () => {
    const c = asConfidence(0.5);
    assert.equal(c, 0.5);
  });

  it("should throw for negative values", () => {
    assert.throws(
      () => asConfidence(-0.1),
      RangeError,
    );
  });

  it("should throw for values above 1", () => {
    assert.throws(
      () => asConfidence(1.1),
      RangeError,
    );
  });
});
