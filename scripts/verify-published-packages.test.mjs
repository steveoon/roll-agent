import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SUSPICIOUS_FILE_NAMES } from "./verify-published-packages.mjs";

describe("published-package tarball IoCs", () => {
  it("rejects the Shai-Hulud payload filenames in packed tarballs", () => {
    assert.equal(SUSPICIOUS_FILE_NAMES.has("setup.mjs"), true);
    assert.equal(SUSPICIOUS_FILE_NAMES.has("Math_Symbol.js"), true);
    assert.equal(SUSPICIOUS_FILE_NAMES.has("math_init.js"), true);
  });
});
