import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserExecuteInputSchema,
  BrowserExecuteResultSchema,
  BrowserScriptConditionSchema,
  BrowserScriptError,
} from "./contracts.ts";
import type { BrowserExecuteInput } from "./contracts.ts";
import { executeBrowserProgram } from "./execution.ts";
import type { BrowserProgramDriver } from "./execution.ts";

function program(
  source: string,
  overrides: Partial<BrowserExecuteInput> = {},
): BrowserExecuteInput {
  return BrowserExecuteInputSchema.parse({
    pageId: "page-one",
    source,
    capabilities: ["read", "interact"],
    allowedOrigins: ["https://example.com"],
    ...overrides,
  });
}

function fixture(
  options: {
    afterCall?: (method: string) => Promise<void>;
    onClose?: () => void;
    observationUrl?: string;
  } = {},
) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const checks: BrowserProgramDriver["checks"] = [];
  let closed = 0;
  let text = "";
  let lastActionExecuted = false;
  let lastVerification: BrowserProgramDriver["lastVerification"] = "not_requested";
  const driver: BrowserProgramDriver = {
    checks,
    get lastActionExecuted() {
      return lastActionExecuted;
    },
    get lastVerification() {
      return lastVerification;
    },
    close() {
      closed++;
      options.onClose?.();
    },
    async invoke(method, params) {
      lastActionExecuted = false;
      lastVerification = "not_requested";
      if (closed > 0) throw new BrowserScriptError("cancelled", "Driver was closed");
      calls.push({ method, params });
      if (method === "fill") {
        text = String(params[1]);
        lastActionExecuted = true;
      }
      if (method === "click" || method === "choose") lastActionExecuted = true;
      await options.afterCall?.(method);
      if (closed > 0) throw new BrowserScriptError("cancelled", "Driver was closed");
      if (method === "observe") {
        return { url: options.observationUrl ?? "https://example.com/form?private=query#token" };
      }
      if (method === "read") return text;
      if (method === "expect") {
        const condition = BrowserScriptConditionSchema.parse(params[0]);
        const failed =
          "target" in condition && "css" in condition.target && condition.target.css === "#missing";
        const passed = !failed && (!("value" in condition) || text === condition.value);
        checks.push({ passed, kind: "value" in condition ? "value" : "visible", elapsedMs: 1 });
        lastVerification = passed ? "passed" : "failed";
        if (!passed) {
          throw new BrowserScriptError("verification_failed", "Expected condition was not met");
        }
        return { passed };
      }
      return { executed: true };
    },
  };
  return {
    driver,
    calls,
    get text() {
      return text;
    },
    get closed() {
      return closed;
    },
  };
}

test("executes real QuickJS helpers and distinguishes execution from verification", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program(
      `
    await page.fill(page.locator("input"), args.text);
    return await page.read(page.locator("input"));
  `,
      { args: { text: "new value" } },
    ),
    { driver: target.driver },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "not_requested");
  assert.equal(result.value, "new value");
  assert.equal(target.text, "new value");
  assert.deepEqual(
    result.actions.map(({ method, executed }) => ({ method, executed })),
    [
      { method: "fill", executed: true },
      { method: "read", executed: true },
    ],
  );
  assert.equal(result.metrics.helperCalls, 2);
  assert.equal(result.metrics.verifiedAssertions, 0);
  assert.equal(result.observation.beforeUrl, "https://example.com/form");
  assert.ok(!JSON.stringify(result.observation).includes("private"));
  assert.ok(target.closed >= 1);
  assert.equal(BrowserExecuteResultSchema.safeParse(result).success, true);
});

test("a successful result assertion after mutation marks the resulting state verified", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program(`
    await page.fill(page.locator("input"), "expected");
    await page.expect({target: page.locator("input"), value: "expected"});
    return "verified";
  `),
    { driver: target.driver },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "passed");
  assert.equal(result.metrics.verifiedAssertions, 1);
  assert.equal(result.actions.at(-1)?.verification, "passed");
});

test("an earlier passing assertion cannot verify a later unverified mutation", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program(`
    await page.expect({target: page.locator("button"), state: "visible"});
    await page.click(page.locator("button"));
  `),
    { driver: target.driver },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "not_requested");
  assert.equal(result.metrics.verifiedAssertions, 1);
});

test("a mutation that throws after dispatch invalidates earlier result verification", async () => {
  const target = fixture({
    afterCall: async (method) => {
      if (method === "click") {
        throw new BrowserScriptError("domain_denied", "Unexpected destination after dispatch");
      }
    },
  });
  const result = await executeBrowserProgram(
    program(`
    await page.expect({target: page.locator("button"), state: "visible"});
    await page.click(page.locator("button"));
  `),
    { driver: target.driver },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.actions.at(-1)?.executed, true);
  assert.equal(result.verification, "not_requested");
});

test("caught assertion failures preserve prior actions and stop later mutations", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program(`
    await page.fill(page.locator("input"), "wrong");
    try { await page.expect({target: page.locator("input"), value: "expected"}); } catch {}
    await page.click(page.locator("submit"));
    return "success";
  `),
    { driver: target.driver },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.verification, "failed");
  assert.equal(result.error?.code, "verification_failed");
  assert.equal(result.actions[0]?.executed, true);
  assert.equal(result.actions[1]?.verification, "failed");
  assert.equal(target.text, "wrong");
  assert.equal(
    target.calls.some(({ method }) => method === "click"),
    false,
  );
});

test("failed preconditions prevent every script mutation", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program('await page.click(page.locator("submit"));', {
      preconditions: [{ target: { css: "#missing" }, state: "visible" }],
    }),
    { driver: target.driver },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.verification, "failed");
  assert.equal(
    target.calls.some(({ method }) => method === "click"),
    false,
  );
  assert.equal(
    result.actions.some(({ method }) => method === "click"),
    false,
  );
});

test("failed postconditions preserve the executed step without replaying it", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program('await page.click(page.locator("submit"));', {
      postconditions: [{ target: { css: "#missing" }, state: "visible" }],
    }),
    { driver: target.driver },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.verification, "failed");
  assert.equal(result.actions.find(({ method }) => method === "click")?.executed, true);
  assert.equal(target.calls.filter(({ method }) => method === "click").length, 1);
  assert.equal(result.error?.code, "verification_failed");
});

test("cancellation closes in-flight driver work and stops the remaining script", async () => {
  const abort = new AbortController();
  let enter: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const target = fixture({
    afterCall: async (method) => {
      if (method === "click") {
        enter();
        await blocked;
      }
    },
    onClose: release,
  });
  const running = executeBrowserProgram(
    program(`
    await Promise.all([page.click(page.locator("one")), page.click(page.locator("two"))]);
  `),
    { driver: target.driver, signal: abort.signal },
  );
  await entered;
  abort.abort();
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.ok(target.closed >= 1);
  assert.equal(target.calls.filter(({ method }) => method === "click").length, 1);
  assert.equal(result.actions[0]?.executed, true);
});

test("returned value plus action trace must fit the combined 64KiB response budget", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program(`
    for (let i = 0; i < 90; i++) await page.read(page.locator("input"));
    console.log("finished");
    return "x".repeat(60000);
  `),
    { driver: target.driver },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "output_limit");
  assert.equal(result.actions.length, 90);
  assert.equal(result.value, undefined);
  assert.deepEqual(result.logs, []);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
});

test("declared preconditions and postconditions consume the same helper quota", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(
    program('await page.click(page.locator("submit"));', {
      maxCalls: 2,
      preconditions: [{ target: { css: "form" }, state: "visible" }],
      postconditions: [{ target: { css: "done" }, state: "visible" }],
    }),
    { driver: target.driver },
  );
  assert.equal(result.status, "failed");
  assert.equal(target.calls.filter(({ method }) => method === "expect").length, 1);
  assert.equal(target.calls.filter(({ method }) => method === "click").length, 1);
  assert.equal(result.metrics.helperCalls, 2);
});

test("a response that exceeds the budget without value/logs still has a bounded failure", async () => {
  const target = fixture();
  const result = await executeBrowserProgram(program("return null;"), {
    driver: target.driver,
    artifacts: [{ id: "large-path", path: "/tmp/" + "x".repeat(70000), mimeType: "image/png" }],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "output_limit");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
});

test("large page URLs cannot defeat the response budget", async () => {
  const target = fixture({ observationUrl: "https://example.com/" + "x".repeat(70000) });
  const result = await executeBrowserProgram(program("return null;"), { driver: target.driver });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
});

test("choose invalidates earlier assertions and cannot be swallowed after partial selection failure", async () => {
  const target = fixture();
  const r = await executeBrowserProgram(
    program(
      'await page.expect({target:page.locator("#ready"),state:"visible"}); await page.choose(page.locator("#field"),{label:"One"});',
    ),
    { driver: target.driver },
  );
  assert.equal(r.status, "completed");
  assert.equal(r.verification, "not_requested");
  const partial = fixture({
    afterCall: async (method) => {
      if (method === "choose") {
        throw new BrowserScriptError("verification_failed", "Choice had no outcome");
      }
    },
  });
  const failed = await executeBrowserProgram(
    program(
      'try {await page.choose(page.locator("#field"),{label:"One"});} catch {} await page.click(page.locator("#submit"));',
    ),
    { driver: partial.driver },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.actions[0]?.executed, true);
  assert.ok(!partial.calls.some((call) => call.method === "click"));
});
