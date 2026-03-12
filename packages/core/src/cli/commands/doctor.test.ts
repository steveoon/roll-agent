import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNodeVersionSupported } from "./doctor.ts";

describe("isNodeVersionSupported", () => {
  it("should reject versions lower than 22.6.0", () => {
    assert.equal(isNodeVersionSupported("22.5.9"), false);
    assert.equal(isNodeVersionSupported("21.9.0"), false);
  });

  it("should accept version 22.6.0 and above", () => {
    assert.equal(isNodeVersionSupported("22.6.0"), true);
    assert.equal(isNodeVersionSupported("22.7.0"), true);
    assert.equal(isNodeVersionSupported("23.0.0"), true);
  });

  it("should reject invalid version strings", () => {
    assert.equal(isNodeVersionSupported("invalid"), false);
  });
});
