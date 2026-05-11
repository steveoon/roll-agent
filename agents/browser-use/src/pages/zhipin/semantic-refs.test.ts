import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildZhipinCandidateRef,
  clearZhipinCandidateRefsForTests,
  rememberZhipinCandidateRefs,
  parseZhipinCandidateRef,
  resolveZhipinCandidateIndex,
  resolveZhipinCandidateIndices,
  resolveZhipinCandidateRefTarget,
} from "./semantic-refs.ts";

afterEach(() => {
  clearZhipinCandidateRefsForTests();
});

describe("zhipin semantic refs", () => {
  it("builds 1-based candidate refs from 0-based indices", () => {
    assert.equal(buildZhipinCandidateRef(0), "@c1");
    assert.equal(buildZhipinCandidateRef(12), "@c13");
  });

  it("parses candidate refs back to 0-based indices", () => {
    assert.equal(parseZhipinCandidateRef("@c1"), 0);
    assert.equal(parseZhipinCandidateRef("c2"), 1);
    assert.equal(parseZhipinCandidateRef("@C10"), 9);
  });

  it("rejects invalid candidate refs", () => {
    assert.equal(parseZhipinCandidateRef("@c0"), undefined);
    assert.equal(parseZhipinCandidateRef("@x1"), undefined);
  });

  it("prefers explicit index when both index and candidateRef are provided", () => {
    assert.equal(resolveZhipinCandidateIndex({ index: 3, candidateRef: "@c1" }), 3);
  });

  it("resolves and deduplicates mixed indices and refs", () => {
    assert.deepEqual(
      resolveZhipinCandidateIndices({ indices: [0], candidateRefs: ["@c1", "@c3"] }),
      [0, 2],
    );
  });

  it("remembers candidate refs by output order while keeping the actionable DOM index", () => {
    const targets = rememberZhipinCandidateRefs([
      { index: 0, candidateId: "candidate-a", name: "候选人 A" },
      { index: 0, candidateId: "candidate-b", name: "候选人 B" },
    ]);

    assert.deepEqual(
      targets.map((target) => target.candidateRef),
      ["@c1", "@c2"],
    );
    assert.deepEqual(resolveZhipinCandidateRefTarget("@c2"), {
      index: 0,
      candidateId: "candidate-b",
      name: "候选人 B",
      candidateRef: "@c2",
    });
    assert.deepEqual(resolveZhipinCandidateIndices({ candidateRefs: ["@c1", "@c2"] }), [0, 0]);
  });
});
