import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserProgramDriver } from "@roll-agent/browser";
import { ExecutionVisualFeedback } from "./execution-visual-feedback.ts";
import { setVisualActivityEnabledForTests } from "./visual-activity.ts";
import { setVisualCursorEnabledForTests } from "./visual-cursor.ts";

afterEach(() => {
  setVisualActivityEnabledForTests(undefined);
  setVisualCursorEnabledForTests(undefined);
});

test("execution feedback reports preparation, dispatch, verification and uncertainty without input data", async () => {
  setVisualActivityEnabledForTests(true);
  setVisualCursorEnabledForTests(true);
  const expressions: string[] = [];
  const visual = new ExecutionVisualFeedback(
    {
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        expressions.push(expression);
        return true as T;
      },
    },
    "form",
  );
  let executed = false;
  let verification: BrowserProgramDriver["lastVerification"] = "not_requested";
  let shouldFail = false;
  const driver: BrowserProgramDriver = {
    checks: [],
    get lastActionExecuted() {
      return executed;
    },
    get lastVerification() {
      return verification;
    },
    close: () => {},
    invoke: async () => {
      executed = true;
      if (shouldFail) throw new Error("native dispatch failed");
      verification = "passed";
      return { executed: true };
    },
  };

  await visual.begin();
  await visual.setStage("deciding");
  await visual.invoke(driver, "fill", [{ css: "#private-field" }, "secret-value"]);
  await visual.pointer({ type: "mouseMoved", x: 20, y: 25 });
  await visual.pointer({ type: "mousePressed", x: 20, y: 25 });
  shouldFail = true;
  verification = "not_requested";
  await assert.rejects(visual.invoke(driver, "click", [{ role: "button", name: "Private" }]));
  await visual.finish("交互已结束 · 待上层验收", "info");

  const output = expressions.join("\n");
  assert.match(output, /正在决定下一步/u);
  assert.match(output, /填写输入框已执行并校验/u);
  assert.match(output, /点击控件已发出 · 结果未确认/u);
  assert.match(output, /交互已结束 · 待上层验收/u);
  assert.doesNotMatch(output, /private-field|secret-value|Private/u);
  assert.match(output, /root\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(output, /root\.setAttribute\("inert", ""\)/u);
  assert.match(output, /item\.textContent =/u);
  assert.match(output, /card\.style\.pointerEvents = "none"/u);
});

test("execution card and cursor respect independent visual toggles", async () => {
  setVisualActivityEnabledForTests(false);
  setVisualCursorEnabledForTests(true);
  const expressions: string[] = [];
  const visual = new ExecutionVisualFeedback(
    {
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        expressions.push(expression);
        return true as T;
      },
    },
    "script",
  );
  await visual.begin();
  assert.equal(expressions.length, 1);
  assert.match(expressions[0]!, /"executionLifecycle":/u);
  assert.doesNotMatch(expressions[0]!, /"executionCard":/u);
  await visual.pointer({ type: "mouseMoved", x: 2, y: 3 });
  assert.equal(expressions.length, 2);
  assert.match(expressions[1]!, /"cursor":/u);
  setVisualCursorEnabledForTests(false);
  await visual.pointer({ type: "mousePressed", x: 2, y: 3 });
  assert.equal(expressions.length, 2);
});

test("completion drains an in-flight card update before rendering terminal state", async () => {
  setVisualActivityEnabledForTests(true);
  const rendered: string[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const visual = new ExecutionVisualFeedback(
    {
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        if (expression.includes('"stage":"正在决定下一步"')) await blocked;
        rendered.push(expression);
        return true as T;
      },
    },
    "task",
  );
  await visual.begin();
  visual.setStage("deciding");
  const completed = visual.finish("交互已结束 · 待上层验收", "info");
  await delay(10);
  assert.doesNotMatch(rendered.join("\n"), /交互已结束 · 待上层验收/u);
  release();
  await completed;
  assert.match(rendered.at(-1) ?? "", /交互已结束 · 待上层验收/u);
});
