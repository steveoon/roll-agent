import { test } from "node:test";
import assert from "node:assert/strict";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { estimatePreparedRequest, RequestBudgetTracker } from "./request-budget.ts";

function params(text = "hello"): LanguageModelV4CallOptions {
  return {
    prompt: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text }] },
    ],
    tools: [
      {
        type: "function",
        name: "tool",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        description: "actual resolved description",
      },
    ],
  };
}
const settings = {
  provider: "mock",
  model: "fixture",
  window: 10000,
  windowSource: "override" as const,
  threshold: 0.75,
};
test("prepared components, explicit output reserve and unknown capacity are honest estimates", () => {
  const small = estimatePreparedRequest(params(), settings, 0);
  const large = estimatePreparedRequest({ ...params(), maxOutputTokens: 9500 }, settings, 0);
  assert.ok(small.systemTokens > 0 && small.toolTokens > 0 && small.messageTokens > 0);
  assert.equal(
    small.rawInputEstimate,
    small.systemTokens + small.toolTokens + small.messageTokens + small.optionTokens,
  );
  assert.equal(small.estimated, true);
  assert.equal(large.outputReserve, 9500);
  assert.ok(large.availableInputCeiling! < small.availableInputCeiling!);
  const unknown = estimatePreparedRequest(params(), { provider: "mock", model: "fixture" }, 0);
  assert.equal(unknown.windowSource, "unknown");
  assert.equal(unknown.window, undefined);
  assert.equal(unknown.availableInputCeiling, undefined);
});
test("latest exact dispatched measurement replaces earlier larger input; billing and output are not occupancy", () => {
  const t = new RequestBudgetTracker();
  const first = t.prepare(params(), settings, "context");
  t.measured(first, 5000);
  assert.equal(
    t.prepare(params("long"), settings, "context").calibrationResidual,
    5000 - first.rawInputEstimate,
  );
  const next = t.prepare(params("long"), settings, "context");
  t.measured(next, next.rawInputEstimate + 10);
  const final = t.prepare(params("next"), settings, "context");
  assert.equal(final.calibrationResidual, 10);
  assert.equal(final.latestMeasuredInput, next.rawInputEstimate + 10);
  assert.equal(
    t.prepare(params("next"), settings, "different-checkpoint").measurementMatched,
    false,
  );
});
test("maintenance comparison freezes residual; reset and larger payload never manufacture space release", () => {
  const t = new RequestBudgetTracker();
  const initial = t.prepare(params("old"), settings, "old-shape");
  t.measured(initial, initial.rawInputEstimate + 1000);
  const before = t.prepare(params("old"), settings, "old-shape");
  t.beginMaintenance(before);
  assert.equal(t.view().comparison?.after, undefined);
  const after = t.prepare(params("old plus new checkpoint text"), settings, "new-shape");
  assert.equal(after.calibrationResidual, 0, "new shape invalidates admission calibration");
  assert.equal(t.view().comparison?.after?.calibrationResidual, before.calibrationResidual);
  assert.ok(t.view().comparison!.savedTokens! <= 0);
  assert.equal(t.view().comparison!.spaceImproved, false);
});

test("compatible measured overestimation corrects admission without discounting new shapes", () => {
  const tracker = new RequestBudgetTracker();
  const first = tracker.prepare(params("x".repeat(36000)), settings, "same");
  assert.ok(first.rawInputEstimate > first.availableInputCeiling!);
  tracker.measured(first, 5000);
  const next = tracker.prepare(params("x".repeat(36000)), settings, "same");
  assert.equal(next.calibratedInputEstimate, 5000);
  assert.ok(next.calibrationResidual < 0);
  assert.equal(tracker.predict([], 0), 5000, "predictor has no raw-estimate floor");
  const smaller = tracker.prepare(params("x".repeat(18000)), settings, "same");
  assert.ok(smaller.calibratedInputEstimate > 2000);
  const larger = tracker.prepare(params("x".repeat(60000)), settings, "same");
  assert.ok(larger.calibratedInputEstimate > larger.availableInputCeiling!);
  const changed = tracker.prepare(params("x".repeat(36000)), settings, "new-tools");
  assert.equal(changed.calibrationResidual, 0);
  assert.ok(changed.calibratedInputEstimate > changed.availableInputCeiling!);
});

test("negative opaque calibration cannot discount plain text or a replaced encrypted payload", () => {
  const tracker = new RequestBudgetTracker();
  const opaque = {
    ...params("small"),
    prompt: [
      ...params("small").prompt,
      {
        role: "assistant" as const,
        content: [
          {
            type: "reasoning" as const,
            text: "think",
            providerOptions: { openai: { reasoningEncryptedContent: "A".repeat(36000) } },
          },
        ],
      },
    ],
  };
  const first = tracker.prepare(opaque, settings, "same");
  tracker.measured(first, 5000);
  assert.equal(tracker.prepare(opaque, settings, "same").calibratedInputEstimate, 5000);
  const plain = tracker.prepare(params("x".repeat(36000)), settings, "same");
  assert.equal(plain.measurementMatched, false);
  assert.ok(plain.calibratedInputEstimate > plain.availableInputCeiling!);
});
test("actual schema/description/system/provider option changes invalidate exact shape; opaque binary counted separately", () => {
  const t = new RequestBudgetTracker();
  const before = t.prepare(params(), settings, "context");
  t.measured(before, before.rawInputEstimate + 20);
  const changed = t.prepare(
    { ...params(), providerOptions: { mock: { effort: "high" } } },
    settings,
    "context",
  );
  assert.notEqual(changed.shapeFingerprint, before.shapeFingerprint);
  assert.equal(changed.measurementMatched, false);
  const image = estimatePreparedRequest(
    {
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: { type: "data", data: new Uint8Array(1000) },
              mediaType: "image/png",
            },
          ],
        },
      ],
    },
    settings,
    0,
  );
  assert.equal(image.opaqueOrMultimodal, true);
  assert.ok(image.messageTokens >= 2048);
});
