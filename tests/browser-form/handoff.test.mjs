import assert from "node:assert/strict";
import { test } from "node:test";
import { executeToolForMcp } from "../../packages/sdk/src/define-agent.ts";
import { normalizeToolResult } from "../../packages/runtime/src/tool-bridge/normalize-result.ts";
import { BrowserOperateOutputSchema } from "../../agents/browser-use/src/goal/contracts.ts";
import { compactFormOperateOutput } from "../../agents/browser-use/src/goal/operate-handoff.ts";
import { browserOperate } from "../../agents/browser-use/src/tools/browser-operate.ts";

test("large form output crosses MCP and runtime normalization without clipping handoff", async () => {
  const raw = BrowserOperateOutputSchema.parse({
    status: "failed",
    verified: false,
    elapsedMs: 15000,
    execution: {
      invocationId: "i",
      revision: 3,
      documentChanged: false,
      changes: [],
      form: {
        mode: "create",
        stopAt: "current-view",
        fields: [
          {
            id: "f1",
            name: "Salary",
            intent: "set",
            comparison: "literal",
            expected: "8k",
            current: "",
            status: "unknown",
            reason: "missing editor",
          },
        ],
      },
    },
    steps: [
      {
        step: 1,
        operation: "CLICK",
        executed: true,
        error: "uncertain",
        observationMs: 1,
        decisionMs: 1,
        actionMs: 1,
        provider: "test",
        requestedModel: "test",
        resolvedModel: "test",
        distributions: {
          operation: {
            probabilities: Object.fromEntries(
              Array.from({ length: 8000 }, (_, i) => [`target${i}`, 0.001]),
            ),
          },
        },
      },
    ],
    finalObservation: { observationFresh: false, pageText: "x".repeat(100000) },
  });
  const tool = { ...browserOperate, execute: async () => compactFormOperateOutput(raw) };
  const ctx = {
    llm: {
      generateText: async () => {
        throw Error("No model calls");
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const result = await executeToolForMcp(tool, ctx, {
    pageId: "p",
    goal: "fill form",
    allowedOrigins: ["https://example.com"],
  });
  assert.ok(BrowserOperateOutputSchema.safeParse(JSON.parse(result.content[0].text)).success);
  const normalized = normalizeToolResult(result);
  assert.ok(!JSON.stringify(normalized.model).includes("工具模型内容已截断"));
  assert.ok(!JSON.stringify(normalized.model).includes("structuredContent"));
  assert.match(JSON.stringify(normalized.model), /handoff/);
  assert.equal(JSON.parse(result.content[0].text).steps[0].error, "uncertain");
});

test(
  "real browser tool entries fill locally and deliver actionable failures and form handoff",
  { skip: process.env.RUN_FORM_RECOVERY_E2E !== "1", timeout: 45000 },
  async (t) => {
    const { browserTestFixture } =
      await import("../../agents/browser-use/src/goal/browser-test-fixture.e2e.ts");
    const { BrowserRuntime, BrowserRuntimeConfigSchema } =
      await import("../../packages/browser/src/index.ts");
    const { setRuntimeStateForTests } =
      await import("../../agents/browser-use/src/runtime-holder.ts");
    const { browserExecute } =
      await import("../../agents/browser-use/src/tools/browser-execute.ts");
    const fixture = await browserTestFixture(
      () =>
        '<html><body><textarea aria-label="Notes" id="notes"></textarea><button id="publish" onclick="window.published=true">Publish</button></body></html>',
    );
    const previousEngine = process.env.BROWSER_OPERATE_ENGINE;
    process.env.BROWSER_OPERATE_ENGINE = "sampling";
    t.after(async () => {
      t.mock.restoreAll();
      setRuntimeStateForTests({});
      if (previousEngine === undefined) delete process.env.BROWSER_OPERATE_ENGINE;
      else process.env.BROWSER_OPERATE_ENGINE = previousEngine;
      await fixture.close();
    });
    await fixture.controller.navigate(fixture.origin);
    for (let i = 0; i < 40; i++) {
      if (await fixture.controller.evaluateJson('Boolean(document.getElementById("notes"))')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const runtime = new BrowserRuntime(
      BrowserRuntimeConfigSchema.parse({ security: { actionPolicy: "log" } }),
    );
    t.mock.method(runtime, "listNativePages", async () => [
      { targetId: fixture.pageId, url: fixture.origin, title: "Fixture" },
    ]);
    t.mock.method(runtime, "connectNativePage", async () => fixture.controller);
    t.mock.method(fixture.controller, "close", () => {});
    setRuntimeStateForTests({ runtime });
    const ctx = {
      llm: {
        generateText: async (prompt) => {
          const request = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
          return JSON.stringify({
            ...Object.fromEntries(
              Object.entries(request.questions).map(([key, q]) => [
                key,
                Object.hasOwn(q.criteria, "NONE") ? "NONE" : Object.keys(q.criteria)[0],
              ]),
            ),
            operation: "REASSESS",
          });
        },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const executed = await executeToolForMcp(browserExecute, ctx, {
      pageId: fixture.pageId,
      allowedOrigins: [fixture.origin],
      capabilities: ["read", "interact"],
      source:
        "const t=page.locator('#notes');await page.fill(t,'Draft');await page.read(t,{attribute:'value'});await page.click(page.locator('#publish'));",
    });
    const failed = JSON.parse(executed.content[0].text);
    assert.equal(failed.error.code, "invalid_argument");
    assert.match(failed.error.message, /options.attribute/);
    assert.equal(failed.actions[0].executed, true);
    assert.equal(failed.actions[1].executed, false);
    assert.equal(
      await fixture.controller.evaluateJson('document.getElementById("notes").value'),
      "Draft",
    );
    assert.equal(await fixture.controller.evaluateJson("Boolean(window.published)"), false);
    const operated = await executeToolForMcp(browserOperate, ctx, {
      pageId: fixture.pageId,
      allowedOrigins: [fixture.origin],
      goal: "Fill Notes without publishing",
      values: [{ name: "notes", text: "Draft" }],
      formTask: { mode: "edit", fields: [{ name: "Notes", intent: "set", valueName: "notes" }] },
    });
    const handoff = JSON.parse(operated.content[0].text);
    assert.equal(handoff.status, "needs_reasoning", JSON.stringify(handoff));
    assert.equal(handoff.verified, false);
    assert.equal(handoff.handoff.fields[0].name, "Notes");
    assert.equal(handoff.handoff.observationFresh, true);
    assert.ok(!JSON.stringify(normalizeToolResult(operated).model).includes("工具模型内容已截断"));
  },
);
