import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { waitForPromiseSettlement } from "./bounded-wait.ts";

test("waitForPromiseSettlement 对 fulfilled/rejected 都返回 settled", async () => {
  assert.equal(await waitForPromiseSettlement(Promise.resolve(), 1_000), true);
  assert.equal(
    await waitForPromiseSettlement(Promise.reject(new Error("expected rejection")), 1_000),
    true,
  );
});

test("waitForPromiseSettlement 在 promise 未完成时按预算返回 false", async () => {
  const keepAlive = setTimeout(() => undefined, 1_000);
  try {
    assert.equal(await waitForPromiseSettlement(new Promise(() => {}), 10), false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("waitForPromiseSettlement 的 timeout timer 不单独阻止 Node 退出", async () => {
  const moduleUrl = new URL("./bounded-wait.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `import { waitForPromiseSettlement } from ${JSON.stringify(moduleUrl)}; void waitForPromiseSettlement(new Promise(() => {}), 60_000);`,
    ],
    { stdio: "ignore" },
  );
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 2_000);

  try {
    const { exitCode, signal } = await new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    assert.equal(signal, null, "child should exit naturally instead of hitting the watchdog");
    assert.equal(exitCode, 0);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});
