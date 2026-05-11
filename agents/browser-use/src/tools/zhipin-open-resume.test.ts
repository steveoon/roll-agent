import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zhipinOpenResume } from "./zhipin-open-resume.ts";

describe("zhipin_open_resume", () => {
  it("accepts candidateRef input", () => {
    const parsed = zhipinOpenResume.input.parse({ candidateRef: "@c1" });

    assert.equal(parsed.candidateRef, "@c1");
  });

  it("rejects invalid candidateRef input before execution", () => {
    assert.throws(
      () => zhipinOpenResume.input.parse({ candidateRef: "candidate-1" }),
      /candidateRef 应类似 @c1/,
    );
  });
});
