import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModelConfigController,
  type RuntimeModelConfigReloadResult,
} from "./model-config-controller.ts";

const initial = { provider: "original", model: "original-model" };
const applied = {
  status: "applied",
  model: { provider: "next", model: "next-model" },
  reasoning: "summary",
} as const;

test("session-only model changes update status without pretending to reload configuration", () => {
  let busy = false;
  const control = new ModelConfigController({
    host: { initial, reload: () => applied },
    isBusy: () => busy,
  });
  control.adoptActive({ provider: "manual", model: "manual-model" }, "text");
  assert.deepEqual(control.getStatus(), {
    status: "applied",
    revision: 0,
    active: { provider: "manual", model: "manual-model", revision: 0, reasoning: "text" },
  });
  busy = true;
  control.reload();
  assert.throws(() => control.adoptActive(initial));
});

test("reload coalesces while busy and applies synchronously after every turn settles", () => {
  let busy = true;
  let calls = 0;
  const control = new ModelConfigController({
    host: {
      initial,
      reload: () => {
        calls++;
        return applied;
      },
    },
    isBusy: () => busy,
    initialReasoning: "text",
  });
  assert.equal(control.reload().status, "pending");
  assert.equal(control.reload().revision, 2);
  assert.equal(calls, 0);
  assert.throws(() => control.assertReady(), /等待/);
  busy = false;
  control.tryApply();
  assert.deepEqual(control.getStatus(), {
    status: "applied",
    revision: 2,
    active: { ...applied.model, revision: 2, reasoning: "summary" },
  });
  assert.equal(calls, 1);
  control.assertReady();
});

test("async reloads serialize, keep admission blocked and report the actual active identity", async () => {
  const resolvers: Array<(value: RuntimeModelConfigReloadResult) => void> = [];
  const observations: unknown[] = [];
  const control = new ModelConfigController({
    host: { initial, reload: () => new Promise((resolve) => resolvers.push(resolve)) },
    isBusy: () => false,
    onApplied: (result) => observations.push(result.model),
  });
  control.reload();
  control.reload();
  const settled = control.whenSettled();
  assert.equal(resolvers.length, 1);
  resolvers[0]?.(applied);
  await Promise.resolve();
  assert.equal(resolvers.length, 2);
  assert.equal(control.getStatus().status, "pending");
  assert.deepEqual(control.getStatus().active, {
    ...applied.model,
    revision: 1,
    reasoning: "summary",
  });
  assert.throws(() => control.assertReady());
  resolvers[1]?.({ status: "applied", model: { provider: "final", model: "final-model" } });
  assert.deepEqual(await settled, {
    status: "applied",
    revision: 2,
    active: { provider: "final", model: "final-model", revision: 2, reasoning: null },
  });
  assert.equal(observations.length, 2);
});

test("host failures are sanitized, preserve active identity and recover only by explicit reload", async () => {
  let fail = true;
  const control = new ModelConfigController({
    host: {
      initial,
      reload: async () => {
        if (fail) throw new Error("secret-provider-key");
        return applied;
      },
    },
    isBusy: () => false,
  });
  control.reload();
  const failed = await control.whenSettled();
  assert.equal(failed.status, "failed");
  assert.equal(JSON.stringify(failed).includes("secret-provider-key"), false);
  assert.deepEqual(failed.active, { ...initial, revision: 0, reasoning: null });
  assert.throws(() => control.assertReady(), /失败/);
  fail = false;
  control.reload();
  assert.equal((await control.whenSettled()).status, "applied");
});

test("a status observer requesting another reload cannot settle waiters with an obsolete revision", async () => {
  const resolvers: Array<(value: RuntimeModelConfigReloadResult) => void> = [];
  const control = new ModelConfigController({
    host: { initial, reload: () => new Promise((resolve) => resolvers.push(resolve)) },
    isBusy: () => false,
  });
  control.subscribe((status) => {
    if (status.status === "applied" && status.revision === 1) control.reload();
  });
  control.reload();
  let settled = false;
  const waiting = control.whenSettled().then((status) => {
    settled = true;
    return status;
  });
  resolvers[0]?.(applied);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(control.getStatus().revision, 2);
  assert.equal(control.getStatus().status, "pending");
  assert.equal(settled, false);
  resolvers[1]?.(applied);
  assert.equal((await waiting).revision, 2);
});

test("an application callback can close the host without a later applied notification", async () => {
  const control = new ModelConfigController({
    host: { initial, reload: () => applied },
    isBusy: () => false,
    onApplied: () => control.close(),
  });
  assert.equal(control.reload().status, "failed");
  assert.equal((await control.whenSettled()).status, "failed");
});

test("a permanently failed settlement cannot be retried into new model admission", async () => {
  let calls = 0;
  const control = new ModelConfigController({
    host: {
      initial,
      reload: () => {
        calls++;
        return applied;
      },
    },
    isBusy: () => true,
  });
  control.reload();
  control.fail();
  assert.equal((await control.whenSettled()).status, "failed");
  assert.equal(control.reload().status, "failed");
  assert.equal(calls, 0);
  assert.throws(() => control.assertReady());
});

test("close aborts asynchronous preparation before host commit and ignores late completions", async () => {
  let resolvePreparation: (() => void) | undefined;
  const prepared = new Promise<void>((resolve) => {
    resolvePreparation = resolve;
  });
  let committed = false;
  const control = new ModelConfigController({
    host: {
      initial,
      reload: async (signal) => {
        await prepared;
        signal?.throwIfAborted();
        committed = true;
        return applied;
      },
    },
    isBusy: () => false,
  });
  let changes = 0;
  control.subscribe(() => {
    changes++;
  });
  control.reload();
  const settled = control.whenSettled();
  control.close();
  assert.equal((await settled).status, "failed");
  const closedChanges = changes;
  resolvePreparation?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(committed, false);
  assert.equal(changes, closedChanges);
  assert.throws(() => control.reload(), /关闭/);
});
