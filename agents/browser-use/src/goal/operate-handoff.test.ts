import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserOperateOutputSchema } from "./contracts.ts";
import { compactFormOperateOutput } from "./operate-handoff.ts";

function largeResult() {
  return BrowserOperateOutputSchema.parse({
    status: "needs_reasoning",
    verified: false,
    elapsedMs: 17000,
    execution: {
      invocationId: "invocation",
      revision: 31,
      documentChanged: false,
      latestObservation: "last-snapshot",
      changes: [],
      form: {
        mode: "create",
        stopAt: "current-view",
        fields: Array.from({ length: 16 }, (_, i) => ({
          id: `f${i}`,
          name: `Field ${i}`,
          intent: "set",
          comparison: "literal",
          expected: "\u0000".repeat(8000),
          current: "\u0000".repeat(7999),
          status: i === 0 ? "satisfied" : "unknown",
          reason: "not_currently_readable_or_applied",
          fingerprint: "x".repeat(5000),
        })),
      },
    },
    steps: Array.from({ length: 100 }, (_, i) => ({
      step: i + 1,
      observationMs: 150,
      decisionMs: 600,
      actionMs: 100,
      operation: "CLICK",
      executed: true,
      requestedModel: "test",
      resolvedModel: "test",
      provider: "test",
      target: "\u0000".repeat(500),
      error: i === 99 ? "outcome uncertain" : undefined,
      distributions: {
        operation: {
          probabilities: Object.fromEntries(
            Array.from({ length: 300 }, (_, j) => [`CLICK:node${j}`, 0.003]),
          ),
        },
      },
    })),
    error: "Repeated form/option state without field progress",
    pendingRequirements: ["Field 1"],
    finalObservation: { observationFresh: true, pageText: "page".repeat(30000) },
  });
}

test("maximal form handoff is valid, bounded and preserves outcomes without mutating the loop result", () => {
  const raw = largeResult();
  const before = structuredClone(raw);
  for (const status of ["needs_reasoning", "failed", "cancelled", "interaction_done"] as const) {
    const result = compactFormOperateOutput({ ...raw, status });
    assert.ok(JSON.stringify(result).length < 50000);
    assert.ok(BrowserOperateOutputSchema.safeParse(result).success);
    assert.equal(result.status, status);
    assert.equal(result.verified, false);
    assert.equal(result.handoff?.fields.length, 16);
    assert.equal(result.handoff?.fields[0]?.status, "satisfied");
    assert.equal(result.handoff?.fields[1]?.status, "unknown");
    assert.equal(result.handoff?.fields[1]?.valueTruncated, true);
    assert.equal(result.handoff?.totalSteps, 100);
    assert.equal(result.handoff?.omittedSteps, 0);
    assert.equal(result.steps.length, 100);
    assert.equal(result.steps[99]?.executed, true);
    assert.equal(result.steps[99]?.error, "outcome uncertain");
    assert.equal(result.handoff?.observationFresh, true);
    assert.ok(!JSON.stringify(result).includes("distributions"));
  }
  assert.deepEqual(raw, before);
});

test("missing fresh final observation is explicit; non-form output is unchanged", () => {
  const raw = largeResult();
  delete raw.finalObservation;
  assert.equal(compactFormOperateOutput(raw).handoff?.observationFresh, false);
  delete raw.execution;
  assert.equal(compactFormOperateOutput(raw), raw);
});

test("fallback budget retains every action outcome even with maximal diagnostic numbers", () => {
  const raw = largeResult();
  raw.steps = raw.steps.map((step) => ({
    ...step,
    step: Number.MAX_VALUE,
    observationMs: Number.MAX_VALUE,
    decisionMs: Number.MAX_VALUE,
    actionMs: Number.MAX_VALUE,
    textMs: Number.MAX_VALUE,
    decisionAttempts: Number.MAX_VALUE,
    recovery: true,
    usage: {
      inputTokens: Number.MAX_VALUE,
      outputTokens: Number.MAX_VALUE,
      cost: Number.MAX_VALUE,
    },
    requirement: "x".repeat(8000),
    valueName: "x".repeat(8000),
    error: "uncertain ".repeat(1000),
    requestedModel: "x".repeat(8000),
    resolvedModel: "x".repeat(8000),
    provider: "x".repeat(8000),
  }));
  const result = compactFormOperateOutput(raw);
  assert.ok(BrowserOperateOutputSchema.safeParse(result).success);
  assert.ok(JSON.stringify(result).length < 50000);
  assert.equal(result.steps.length, 100);
  assert.equal(result.handoff?.omittedSteps, 0);
  assert.ok(result.steps.every((step) => step.executed && step.error !== undefined));
});
