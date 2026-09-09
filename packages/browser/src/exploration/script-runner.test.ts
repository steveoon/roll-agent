import assert from "node:assert/strict";
import test from "node:test";
import { compileBrowserScript, runBrowserScript } from "./script-runner.ts";

test("runs awaited helpers, loops, JSON arguments and local locator builders", async () => {
  const calls: { method: string; params: unknown[] }[] = [];
  const result = await runBrowserScript({
    source: `
      const rows = [];
      for (let i = 0; i < args.count; i++) {
        rows.push(await page.read(page.getByRole("button", {name: "Save", scope: "form"})));
      }
      await page.click(page.ref("@e1", "snapshot-1"));
      console.log("finished", rows.length);
      return { rows, locator: page.locator("input", {frameId: "f1"}) };
    `,
    args: { count: 3 },
    invoke: async (method, params) => {
      calls.push({ method, params });
      return method === "read" ? "Save" : null;
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.callCount, 4);
  assert.deepEqual(result.value, {
    rows: ["Save", "Save", "Save"],
    locator: { frameId: "f1", css: "input" },
  });
  assert.deepEqual(calls[0], {
    method: "read",
    params: [{ name: "Save", scope: "form", role: "button" }],
  });
  assert.deepEqual(calls[3], {
    method: "click",
    params: [{ ref: "@e1", snapshotId: "snapshot-1" }],
  });
  assert.deepEqual(result.logs, ['["finished",3]']);
});

test("QuickJS has no host globals, page evaluate, CDP or module loader", async () => {
  const result = await runBrowserScript({
    source: `
      let moduleLoaded = false;
      try { await import("node:fs"); moduleLoaded = true; } catch {}
      return {
        globals: [typeof process, typeof require, typeof fetch, typeof Buffer, typeof window, typeof document, typeof WebSocket],
        hidden: [typeof __browserHelper, typeof __scriptLog, typeof page.evaluate, typeof page.cdp],
        escape: page.click.constructor("return typeof process")(), moduleLoaded
      };
    `,
    invoke: async () => {
      throw new Error("No helper calls expected");
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, {
    globals: Array.from({ length: 7 }, () => "undefined"),
    hidden: Array.from({ length: 4 }, () => "undefined"),
    escape: "undefined",
    moduleLoaded: false,
  });
});

test("compilation never executes a body, including wrapper escape attempts", async () => {
  assert.deepEqual(
    await compileBrowserScript("await page.click(page.locator('button')); while(true) {}"),
    { valid: true },
  );
  assert.deepEqual(await compileBrowserScript("throw new Error('private compile contents');"), {
    valid: true,
  });
  assert.equal((await compileBrowserScript("}); while (true) {} //")).valid, false);
  assert.equal((await compileBrowserScript("return (")).valid, false);
});

test("infinite loops are interrupted by the parent deadline", async () => {
  let stopped = 0;
  const result = await runBrowserScript({
    source: "while (true) {}",
    timeoutMs: 300,
    invoke: async () => null,
    onStop: () => {
      stopped++;
    },
  });
  assert.equal(result.status, "timed_out");
  assert.equal(stopped, 1);
  assert.ok(result.elapsedMs < 3000);
});

test("QuickJS heap exhaustion stops the run without crashing the host", async () => {
  const result = await runBrowserScript({
    source: 'const rows = []; while (true) rows.push(new Array(10000).fill("data"));',
    memoryLimitBytes: 2 * 1024 * 1024,
    timeoutMs: 5000,
    invoke: async () => null,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "SCRIPT_ERROR");
  assert.equal(
    (await runBrowserScript({ source: "return 42", invoke: async () => null })).value,
    42,
  );
});

test("combined UTF-8 logs and returned JSON obey the output limit", async () => {
  const result = await runBrowserScript({
    source: 'console.log("😀".repeat(10)); return "😀".repeat(10);',
    maxOutputBytes: 64,
    invoke: async () => null,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(result.logs.join("")) <= 64);
});

test("helper failure cannot be swallowed to perform further side effects", async () => {
  const calls: string[] = [];
  let stopped = 0;
  const result = await runBrowserScript({
    source:
      'try { await page.expect({}); } catch {} await page.click(page.locator("button")); return "success";',
    invoke: async (method) => {
      calls.push(method);
      throw Object.assign(new Error("PRIVATE PAGE DATA"), { code: "ASSERTION_FAILED" });
    },
    onStop: () => {
      stopped++;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "ASSERTION_FAILED");
  assert.deepEqual(calls, ["expect"]);
  assert.equal(stopped, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE PAGE DATA"));
});

test("concurrent helper promises are executed serially in source order", async () => {
  const calls: string[] = [];
  let active = 0;
  const result = await runBrowserScript({
    source:
      'return await Promise.all([page.read(page.locator("one")), page.read(page.locator("two"))]);',
    invoke: async (_method, params) => {
      assert.equal(active++, 0);
      calls.push(JSON.stringify(params));
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return calls.length;
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, [1, 2]);
  assert.deepEqual(calls, ['[{"css":"one"}]', '[{"css":"two"}]']);
});

test("abort blocks queued calls and waits until in-flight host work settles", async () => {
  const abort = new AbortController();
  let enter: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release: () => void = () => {};
  const host = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let stopped = 0;
  let returned = false;
  const running = runBrowserScript({
    source:
      'await Promise.all([page.click(page.locator("one")), page.click(page.locator("two"))]);',
    signal: abort.signal,
    invoke: async () => {
      calls++;
      enter();
      await host;
      return null;
    },
    onStop: () => {
      stopped++;
    },
  }).then((result) => {
    returned = true;
    return result;
  });
  await entered;
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(returned, false);
  assert.equal(stopped, 1);
  release();
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
});

test("helper call quota cannot be bypassed by catching failures", async () => {
  let calls = 0;
  const result = await runBrowserScript({
    source:
      'for (let i = 0; i < 5; i++) { try { await page.read(page.locator("button")); } catch {} }',
    maxCalls: 2,
    invoke: async () => {
      calls++;
      return null;
    },
  });
  assert.equal(result.error?.code, "CALL_LIMIT");
  assert.equal(calls, 2);
});

test("unawaited helpers cannot report completed execution", async () => {
  const result = await runBrowserScript({
    source: 'page.click(page.locator("button")); return "done";',
    invoke: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return null;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "UNAWAITED_HELPERS");
});

test("exceptions, oversized inputs and pre-aborted calls return safe structured failures", async () => {
  const failure = await runBrowserScript({
    source: 'throw new Error("PRIVATE SECRET");',
    invoke: async () => null,
  });
  assert.equal(failure.status, "failed");
  assert.ok(!JSON.stringify(failure).includes("PRIVATE SECRET"));
  const oversized = await runBrowserScript({
    source: "return args",
    args: { value: "x".repeat(65536) },
    invoke: async () => null,
  });
  assert.equal(oversized.error?.code, "INVALID_INPUT");
  const aborted = await runBrowserScript({
    source: "return 1",
    signal: AbortSignal.abort(),
    invoke: async () => null,
  });
  assert.equal(aborted.status, "cancelled");
  assert.equal(aborted.callCount, 0);
});
