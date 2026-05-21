import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildZhipinCandidateRef,
  buildZhipinRecommendJobRef,
  clearZhipinCandidateRefsForTests,
  clearZhipinRecommendJobRefsForTests,
  rememberZhipinCandidateRefs,
  rememberZhipinRecommendJobRefs,
  parseZhipinCandidateRef,
  parseZhipinRecommendJobRef,
  resolveZhipinCandidateIndex,
  resolveZhipinCandidateIndices,
  resolveZhipinCandidateRefTarget,
  resolveZhipinRecommendJobRefTarget,
  runWithZhipinSemanticRefScopeForTests,
} from "./semantic-refs.ts";

afterEach(() => {
  clearZhipinCandidateRefsForTests();
  clearZhipinRecommendJobRefsForTests();
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

  it("builds and parses 1-based recommend job refs", () => {
    assert.equal(buildZhipinRecommendJobRef(0), "@j1");
    assert.equal(buildZhipinRecommendJobRef(7), "@j8");
    assert.equal(parseZhipinRecommendJobRef("@j1"), 0);
    assert.equal(parseZhipinRecommendJobRef("J3"), 2);
    assert.equal(parseZhipinRecommendJobRef("@j0"), undefined);
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

  it("remembers recommend job refs by output order and rejects stale refs", () => {
    const targets = rememberZhipinRecommendJobRefs([
      {
        index: 0,
        value: "job-a",
        label: "服务员 _ 上海 5-6K",
        isCurrent: true,
      },
      {
        index: 1,
        value: "job-b",
        label: "后厨 _ 上海 6-7K",
        isCurrent: false,
      },
    ]);

    assert.deepEqual(
      targets.map((target) => target.jobRef),
      ["@j1", "@j2"],
    );
    assert.deepEqual(resolveZhipinRecommendJobRefTarget("@j2"), {
      index: 1,
      value: "job-b",
      label: "后厨 _ 上海 6-7K",
      isCurrent: false,
      jobRef: "@j2",
    });

    clearZhipinRecommendJobRefsForTests();
    assert.throws(() => resolveZhipinRecommendJobRefTarget("@j2"), /已过期/);
  });

  it("scopes remembered refs by browser instance", () => {
    runWithZhipinSemanticRefScopeForTests("boss-a", () => {
      rememberZhipinCandidateRefs([{ index: 0, candidateId: "candidate-a", name: "候选人 A" }]);
      rememberZhipinRecommendJobRefs([
        { index: 0, value: "job-a", label: "服务员 _ 上海 5-6K", isCurrent: true },
      ]);
    });
    runWithZhipinSemanticRefScopeForTests("boss-b", () => {
      rememberZhipinCandidateRefs([{ index: 0, candidateId: "candidate-b", name: "候选人 B" }]);
      rememberZhipinRecommendJobRefs([
        { index: 0, value: "job-b", label: "后厨 _ 上海 6-7K", isCurrent: true },
      ]);
    });

    const bossA = runWithZhipinSemanticRefScopeForTests("boss-a", () => ({
      candidate: resolveZhipinCandidateRefTarget("@c1"),
      job: resolveZhipinRecommendJobRefTarget("@j1"),
    }));
    const bossB = runWithZhipinSemanticRefScopeForTests("boss-b", () => ({
      candidate: resolveZhipinCandidateRefTarget("@c1"),
      job: resolveZhipinRecommendJobRefTarget("@j1"),
    }));

    assert.equal(bossA.candidate.candidateId, "candidate-a");
    assert.equal(bossA.job.value, "job-a");
    assert.equal(bossB.candidate.candidateId, "candidate-b");
    assert.equal(bossB.job.value, "job-b");
  });
});
