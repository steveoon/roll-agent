import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { ModelRecoveryBudget } from "./model-recovery.ts";

const offline = new Error("offline");
test("model recovery has one five-attempt budget, including failed preparation", async () => {
  let preparations = 0;
  const budget = new ModelRecoveryBudget(
    {
      isRecoverable: (error) => error === offline,
      prepare: async () => {
        preparations += 1;
        if (preparations === 1) throw offline;
      },
    },
    [0, 0, 0, 0, 0],
  );
  const attempts: number[] = [];
  const signal = new AbortController().signal;
  for (let recovered = 0; recovered < 4; recovered += 1) {
    assert.deepEqual(await budget.attempt(offline, signal, (n) => attempts.push(n)), {
      recovered: true,
    });
  }
  assert.deepEqual(await budget.attempt(offline, signal, (n) => attempts.push(n)), {
    recovered: false,
    error: offline,
  });
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.equal(preparations, 5);
});

test("model recovery defaults to five attempts with 1/2/4/8/16 second backoffs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Apply the mock to the budget's named node:timers/promises import as well.
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  let preparations = 0;
  const attempts: number[] = [];
  const budget = new ModelRecoveryBudget({
    isRecoverable: (error) => error === offline,
    prepare: async () => {
      preparations += 1;
    },
  });
  const signal = new AbortController().signal;
  for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000]) {
    const previousPreparations = preparations;
    const pending = budget.attempt(offline, signal, (n) => attempts.push(n));
    t.mock.timers.tick(ms - 1);
    await Promise.resolve();
    assert.equal(preparations, previousPreparations);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { recovered: true });
    assert.equal(preparations, previousPreparations + 1);
  }
  assert.deepEqual(await budget.attempt(offline, signal, (n) => attempts.push(n)), {
    recovered: false,
    error: offline,
  });
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.equal(preparations, 5);
});

test("model recovery does not retry terminal errors and propagates abort during backoff", async () => {
  let preparations = 0;
  const budget = new ModelRecoveryBudget({
    isRecoverable: (error) => error === offline,
    prepare: async () => {
      preparations += 1;
    },
  });
  const controller = new AbortController();
  const terminal = new Error("login");
  assert.deepEqual(await budget.attempt(terminal, controller.signal, () => {}), {
    recovered: false,
    error: terminal,
  });
  const pending = budget.attempt(offline, controller.signal, () => controller.abort());
  await assert.rejects(pending);
  assert.equal(preparations, 0);
});

test("model recovery stops if preparation becomes terminal", async () => {
  const terminal = new Error("login");
  const attempts: number[] = [];
  const budget = new ModelRecoveryBudget(
    {
      isRecoverable: (error) => error === offline,
      prepare: async () => {
        throw terminal;
      },
    },
    [0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    await budget.attempt(offline, new AbortController().signal, (n) => attempts.push(n)),
    { recovered: false, error: terminal },
  );
  assert.deepEqual(attempts, [1]);
});
