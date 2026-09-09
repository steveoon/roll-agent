import assert from "node:assert/strict";
import { test } from "node:test";
import { compileBrowserScript, runBrowserScript } from "./script-runner.ts";

test("final JSON serialization cannot enqueue a hidden browser action and report completion", async () => {
  let calls = 0;
  const result = await runBrowserScript({
    source: 'return { toJSON() { page.click({css: "#unexpected"}); return "looks done"; } };',
    invoke: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("Action failed after serialization");
    },
  });
  assert.notEqual(result.status, "completed");
  assert.equal(calls, 0);
});

test("a returned Proxy cannot smuggle a browser call through a serialization getter", async () => {
  let calls = 0;
  const result = await runBrowserScript({
    source:
      'return new Proxy({}, { get(target, name) { if (name === "toJSON") page.fill({css:"#name"}, "hidden"); return undefined; } });',
    invoke: async () => {
      calls += 1;
      return null;
    },
  });
  assert.notEqual(result.status, "completed");
  assert.equal(calls, 0);
});

test("mutating JSON functions never exposes host globals or arbitrary methods", async () => {
  const methods: string[] = [];
  const result = await runBrowserScript({
    source: `
      const output = { hidden: typeof __browserHelper, node: page.read.constructor("return typeof process")() };
      JSON.stringify = () => "injected";
      JSON.parse = () => "injected";
      await page.read({css:"#safe"});
      try { page.read = () => "changed"; } catch {}
      output.isFrozen = Object.isFrozen(page);
      return output;
    `,
    invoke: async (method) => {
      methods.push(method);
      return null;
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, { hidden: "undefined", node: "undefined", isFrozen: true });
  assert.deepEqual(methods, ["read"]);
});

test("compile-only never executes dynamic function bodies with global or helper effects", async () => {
  const source =
    'globalThis.sideEffect = 1; page.click({css:"button"}); return (() => { while(true) {} })();';
  assert.deepEqual(await compileBrowserScript(source), { valid: true });
});

test("oversized helper replies fail without running the next queued action", async () => {
  const methods: string[] = [];
  const result = await runBrowserScript({
    source: 'await page.read({css:"#data"}); await page.click({css:"#submit"});',
    maxOutputBytes: 256,
    invoke: async (method) => {
      methods.push(method);
      return "x".repeat(257);
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HELPER_RESULT_LIMIT");
  assert.deepEqual(methods, ["read"]);
});

test("overriding Promise.then cannot make an unfinished helper count as completed", async () => {
  const result = await runBrowserScript({
    timeoutMs: 300,
    source:
      'Promise.prototype.then = function () { return Promise.resolve(null); }; await page.click({css:"#submit"}); return "done";',
    invoke: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return null;
    },
  });
  assert.notEqual(result.status, "completed");
});
