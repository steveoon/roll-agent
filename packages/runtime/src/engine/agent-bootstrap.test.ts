import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_BOOTSTRAP_MAX_CONCURRENCY, mapWithBoundedConcurrency } from "./agent-bootstrap.ts";

test("mapWithBoundedConcurrency 空输入不会调用 mapper", async () => {
  let calls = 0;

  const results = await mapWithBoundedConcurrency([], AGENT_BOOTSTRAP_MAX_CONCURRENCY, async () => {
    calls += 1;
    return "unexpected";
  });

  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("mapWithBoundedConcurrency 拒绝非法并发窗口", async () => {
  for (const maxConcurrency of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      mapWithBoundedConcurrency([1], maxConcurrency, async (value) => value),
      {
        name: "RangeError",
        message: "maxConcurrency must be a positive safe integer",
      },
    );
  }
});

test("mapWithBoundedConcurrency 严格限制在飞任务数量", async () => {
  const inputs = [0, 1, 2, 3, 4] as const;
  const gates = inputs.map(() => Promise.withResolvers<void>());
  const startedSignals = inputs.map(() => Promise.withResolvers<void>());
  const started: number[] = [];
  let active = 0;
  let peakActive = 0;

  const mapping = mapWithBoundedConcurrency(inputs, 2, async (value, index) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    started.push(value);
    startedSignals[index]?.resolve();
    try {
      await gates[index]?.promise;
      return value * 10;
    } finally {
      active -= 1;
    }
  });

  await Promise.all([startedSignals[0]?.promise, startedSignals[1]?.promise]);
  assert.deepEqual(started, [0, 1]);
  assert.equal(active, 2);
  assert.equal(peakActive, 2);

  gates[1]?.resolve();
  await startedSignals[2]?.promise;
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(active, 2);

  gates[0]?.resolve();
  await startedSignals[3]?.promise;
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(active, 2);

  gates[3]?.resolve();
  await startedSignals[4]?.promise;
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(active, 2);

  gates[2]?.resolve();
  gates[4]?.resolve();

  assert.deepEqual(await mapping, [0, 10, 20, 30, 40]);
  assert.equal(active, 0);
  assert.equal(peakActive, 2);
});

test("mapWithBoundedConcurrency 逆序完成仍按输入顺序返回", async () => {
  const inputs = ["first", "second", "third"] as const;
  const gates = inputs.map(() => Promise.withResolvers<void>());
  const startedSignals = inputs.map(() => Promise.withResolvers<void>());
  const completedSignals = inputs.map(() => Promise.withResolvers<void>());
  const completionOrder: string[] = [];

  const mapping = mapWithBoundedConcurrency(inputs, 3, async (value, index) => {
    startedSignals[index]?.resolve();
    await gates[index]?.promise;
    completionOrder.push(value);
    completedSignals[index]?.resolve();
    return `${value}-result`;
  });

  await Promise.all(startedSignals.map(({ promise }) => promise));

  gates[2]?.resolve();
  await completedSignals[2]?.promise;
  gates[1]?.resolve();
  await completedSignals[1]?.promise;
  gates[0]?.resolve();

  assert.deepEqual(await mapping, ["first-result", "second-result", "third-result"]);
  assert.deepEqual(completionOrder, ["third", "second", "first"]);
});

test("mapWithBoundedConcurrency 取消后不再领取排队任务", async () => {
  const inputs = [0, 1, 2, 3, 4] as const;
  const controller = new AbortController();
  const starts = inputs.map(() => Promise.withResolvers<void>());
  const started: number[] = [];
  const aborted = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  const mapping = mapWithBoundedConcurrency(
    inputs,
    2,
    async (value, index) => {
      started.push(value);
      starts[index]?.resolve();
      await aborted;
      return `started-${String(value)}`;
    },
    {
      signal: controller.signal,
      onSkipped: (value) => `skipped-${String(value)}`,
    },
  );

  await Promise.all([starts[0]?.promise, starts[1]?.promise]);
  controller.abort(new Error("stop"));

  assert.deepEqual(await mapping, [
    "started-0",
    "started-1",
    "skipped-2",
    "skipped-3",
    "skipped-4",
  ]);
  assert.deepEqual(started, [0, 1]);
});
