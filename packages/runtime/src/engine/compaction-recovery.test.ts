import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError, generateText } from "ai";
import { estimatePreparedRequest, RequestBudgetTracker } from "./request-budget.ts";
import { MaintenanceEpisode } from "./compaction-recovery.ts";
const params = { prompt: [{ role: "system" as const, content: "system" }] };
const before = estimatePreparedRequest(
  params,
  { provider: "mock", model: "fixture", window: 10000 },
  1000,
);

test("absolute pass/preparation budget reserves verification; quantum never renews deadline or allowance", async () => {
  const episode = new MaintenanceEpisode("owner", before, { messages: 100, tools: 0 }, 1000);
  const initial = episode.view();
  for (let i = 0; i < 4; i += 1) {
    episode.beginPass(`state-${i}`);
    episode.installed(true);
    await episode.yieldQuantum();
    episode.verify({
      ...before,
      rawInputEstimate: before.rawInputEstimate + i,
      calibratedInputEstimate: before.calibratedInputEstimate + i,
    });
  }
  const state = episode.view();
  assert.equal(state.yields, 1);
  assert.equal(state.deadline, initial.deadline);
  assert.equal(state.maxPreparations, initial.maxPreparations);
  assert.equal(state.materialSpaceProgress, false);
  assert.equal(state.coverageProgress, true);
  while (episode.canWork(`fresh-${episode.view().passes}`)) {
    episode.beginPass(`fresh-${episode.view().passes}`);
    episode.verify(before);
  }
  const stopped = episode.view();
  assert.ok(stopped.preparations < stopped.maxPreparations);
  episode.verify(before); // the final real admission check remains reserved
  assert.throws(() => episode.beginPass("new"), /maintenance_limit/);
});

test("draft quota follows the larger continuity lane, bounded to 4..32 calls", () => {
  for (const [messages, tools, expected] of [
    [0, 0, 4],
    [60, 60, 6],
    [0, 46, 6],
    [5000, 1, 32],
  ]) {
    const episode = new MaintenanceEpisode(
      "owner",
      before,
      { messages: messages!, tools: tools! },
      1000,
    );
    assert.equal(episode.view().maxDraftCalls, expected);
  }
});

test("aggregate material progress uses frozen basis across tiny shrinks and misleading admission resets", () => {
  const baseline = {
    ...before,
    window: 500000,
    rawInputEstimate: 100000,
    calibratedInputEstimate: 101000,
    calibrationResidual: 1000,
  };
  const episode = new MaintenanceEpisode("owner", baseline, { messages: 1000, tools: 0 }, 1000);
  for (const shrink of [100, 200, 400, 600]) {
    episode.beginPass(`state-${shrink}`);
    episode.installed(true, `checkpoint-${shrink}`);
    assert.equal(episode.view().after, undefined);
    episode.verify({
      ...baseline,
      rawInputEstimate: baseline.rawInputEstimate - shrink,
      calibratedInputEstimate: 0,
      calibrationResidual: -100000,
    });
    assert.equal(episode.view().aggregateSavedTokens, shrink);
    assert.equal(episode.view().materialSpaceProgress, shrink >= 505);
    assert.equal(episode.view().after?.calibrationResidual, 1000);
  }
});

test("actual SDK retries consume provider attempts and expiry preserves one final preparation", async (t) => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      throw new APICallError({
        message: "retry fixture",
        url: "https://mock.invalid",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    },
  });
  const episode = new MaintenanceEpisode("owner", before, { messages: 0, tools: 0 }, 120000);
  await assert.rejects(
    generateText({ model: episode.meter(model), prompt: "summary", maxRetries: 2 }),
  );
  assert.equal(calls, 3);
  assert.equal(episode.view().draftCalls, 3);
  t.mock.timers.enable({ apis: ["Date"], now: episode.view().deadline + 1 });
  await assert.rejects(
    async () => await episode.meter(model).doGenerate(params),
    /maintenance_limit/,
  );
  assert.equal(calls, 3);
  assert.equal(episode.canWork("fresh"), false);
  episode.verify(before);
  assert.ok(episode.view().after);
});

test("one deterministic fallback is available per equivalent state, within the same shared budget", () => {
  const episode = new MaintenanceEpisode("owner", before, { messages: 1000, tools: 1000 }, 1000);
  for (const state of ["a", "b"]) {
    assert.equal(episode.beginPass(state), false);
    episode.verify(before);
    assert.equal(episode.beginPass(state), true);
    episode.verify(before);
    assert.equal(episode.canWork(state), false);
  }
  episode.beginPass("c");
  episode.recordFallback();
  assert.equal(episode.canWork("c"), false, "fallback inside a failed draft also consumes it");
});
test("summary actual Provider attempts including failures consume shared cost before delegation", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      throw new Error("transport");
    },
  });
  const episode = new MaintenanceEpisode("owner", before, { messages: 0, tools: 0 }, 1000);
  const metered = episode.meter(model);
  for (let i = 0; i < episode.view().maxDraftCalls; i += 1) {
    await assert.rejects(async () => await metered.doGenerate(params), /transport/);
  }
  await assert.rejects(async () => await metered.doGenerate(params), /maintenance_limit/);
  assert.equal(calls, episode.view().maxDraftCalls);
  assert.equal(episode.view().draftCalls, calls);
});
test("repeat equivalent state gets at most one deterministic fallback and missing after stays absent", () => {
  const episode = new MaintenanceEpisode("owner", before, { messages: 0, tools: 0 }, 1000);
  assert.equal(episode.beginPass("same"), false);
  episode.installed(false);
  episode.verify(before);
  assert.equal(episode.beginPass("same"), true);
  assert.equal(episode.view().after, undefined);
  episode.installed(false);
  episode.verify(before);
  assert.equal(episode.canWork("same"), false);
  assert.throws(() => episode.beginPass("same"), /maintenance_limit/);
});
test("frozen episode residual spans all verifies while normal new-turn measurement compatibility returns", () => {
  const tracker = new RequestBudgetTracker();
  const settings = { provider: "mock", model: "fixture" };
  const start = tracker.prepare(params, settings, "a", "owner");
  tracker.freezeEpisode("owner", 1000);
  for (const shape of ["b", "c", "d"]) {
    tracker.beginMaintenance(start, "owner");
    assert.equal(tracker.prepare(params, settings, shape, "owner").calibrationResidual, 0);
    assert.equal(tracker.view().comparison?.after?.calibrationResidual, 1000);
  }
  tracker.abandonMaintenance("owner");
  assert.equal(tracker.prepare(params, settings, "new", "new-owner").calibrationResidual, 0);
});
