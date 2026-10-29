import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatFastModeControl, runFastModeCommand } from "./fast-mode.ts";

function pendingConnection() {
  let resolve: () => void = () => assert.fail("connection not initialized");
  let reject: (error: Error) => void = () => assert.fail("connection not initialized");
  const promise = new Promise<void>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve: () => resolve(), reject: (error: Error) => reject(error) };
}

test("Fast availability is independent of its enabled state and follows the provider", () => {
  let available = false;
  const control = createChatFastModeControl({
    isAvailable: () => available,
    getEnabled: () => false,
    prepareEnable: async () => {},
    apply: () => {},
  });
  assert.equal(control.isAvailable(), false);
  available = true;
  assert.equal(control.isAvailable(), true);
  assert.equal(control.getEnabled(), false);
});

for (const outcome of ["connected", "failed"] as const) {
  test(`closing Fast supersedes a pending enable even when connection later ${outcome}`, async () => {
    const connection = pendingConnection();
    let enabled = false;
    const applied: boolean[] = [];
    const control = createChatFastModeControl({
      getEnabled: () => enabled,
      prepareEnable: () => connection.promise,
      apply: (next) => {
        enabled = next;
        applied.push(next);
      },
    });
    const enabling = runFastModeCommand("on", control);
    assert.match((await runFastModeCommand("off", control))?.text ?? "", /已关闭/);
    assert.deepEqual(applied, [false]);
    if (outcome === "connected") connection.resolve();
    else connection.reject(new Error("late connection failure"));
    assert.equal(await enabling, undefined, "superseded work must not announce success or failure");
    assert.equal(control.getEnabled(), false);
    assert.deepEqual(applied, [false]);
  });
}

test("only the latest enable can commit after on/off/on requests complete out of order", async () => {
  const first = pendingConnection();
  const last = pendingConnection();
  let prepares = 0;
  let enabled = false;
  const applied: boolean[] = [];
  const control = createChatFastModeControl({
    getEnabled: () => enabled,
    prepareEnable: () => (++prepares === 1 ? first.promise : last.promise),
    apply: (next) => {
      enabled = next;
      applied.push(next);
    },
  });
  const older = runFastModeCommand("on", control);
  await runFastModeCommand("off", control);
  const newer = runFastModeCommand("on", control);
  last.resolve();
  assert.match((await newer)?.text ?? "", /已开启/);
  first.resolve();
  assert.equal(await older, undefined);
  assert.equal(control.getEnabled(), true);
  assert.deepEqual(applied, [false, true]);
});

test("the current connection failure is reported and leaves the applied preference intact", async () => {
  let applied = false;
  const control = createChatFastModeControl({
    getEnabled: () => false,
    prepareEnable: async () => {
      throw new Error("connection unavailable");
    },
    apply: () => {
      applied = true;
    },
  });
  assert.match(
    (await runFastModeCommand("on", control))?.text ?? "",
    /切换失败.*connection unavailable/,
  );
  assert.equal(applied, false);
  assert.equal(control.getRequestedEnabled(), false);
});

test("Fast command toggles or sets explicitly and leaves failed changes intact", async () => {
  let enabled = false;
  let supported = true;
  const control = createChatFastModeControl({
    getEnabled: () => enabled,
    prepareEnable: async () => {},
    apply: (next) => {
      if (next && !supported) throw new Error("unsupported model");
      enabled = next;
    },
  });
  const enabledNotice = await runFastModeCommand("", control);
  assert.match(enabledNotice?.text ?? "", /已开启.*额度/);
  assert.equal(enabledNotice?.tone, "info");
  assert.equal(enabled, true);
  assert.match((await runFastModeCommand(" off ", control))?.text ?? "", /已关闭/);
  assert.equal(enabled, false);
  supported = false;
  const failedNotice = await runFastModeCommand("on", control);
  assert.match(failedNotice?.text ?? "", /切换失败.*unsupported model/);
  assert.equal(failedNotice?.tone, "warning");
  assert.equal(enabled, false);
  assert.equal(control.getRequestedEnabled(), false);
  supported = true;
  assert.match((await runFastModeCommand("", control))?.text ?? "", /已开启/);
  assert.equal(enabled, true);
  await runFastModeCommand("off", control);
  assert.match((await runFastModeCommand("on extra", control))?.text ?? "", /用法/);
  assert.equal(enabled, false);
  assert.match((await runFastModeCommand("on"))?.text ?? "", /不支持/);
});

for (const outcome of ["connected", "failed"] as const) {
  test(`two bare toggles cancel a pending enable before connection ${outcome}`, async () => {
    const connection = pendingConnection();
    let enabled = false;
    const applied: boolean[] = [];
    const control = createChatFastModeControl({
      getEnabled: () => enabled,
      prepareEnable: () => connection.promise,
      apply: (next) => {
        enabled = next;
        applied.push(next);
      },
    });
    const enabling = runFastModeCommand("", control);
    assert.equal(control.getEnabled(), false, "pending changes must not be shown as applied");
    assert.equal(control.getRequestedEnabled(), true);
    assert.match((await runFastModeCommand("", control))?.text ?? "", /已关闭/);
    assert.equal(control.getRequestedEnabled(), false);
    if (outcome === "connected") connection.resolve();
    else connection.reject(new Error("late connection failure"));
    assert.equal(await enabling, undefined);
    assert.equal(control.getEnabled(), false);
    assert.deepEqual(applied, [false]);
  });
}

test("stale toggle completion cannot clear the target of a newer pending toggle", async () => {
  const first = pendingConnection();
  const last = pendingConnection();
  let enabled = false;
  let prepares = 0;
  const control = createChatFastModeControl({
    getEnabled: () => enabled,
    prepareEnable: () => (++prepares === 1 ? first.promise : last.promise),
    apply: (next) => {
      enabled = next;
    },
  });
  const older = runFastModeCommand("", control);
  await runFastModeCommand("", control);
  const newer = runFastModeCommand("", control);
  first.resolve();
  assert.equal(await older, undefined);
  assert.equal(control.getRequestedEnabled(), true);
  await runFastModeCommand("", control);
  last.resolve();
  assert.equal(await newer, undefined);
  assert.equal(control.getEnabled(), false);
  assert.equal(control.getRequestedEnabled(), false);
});
