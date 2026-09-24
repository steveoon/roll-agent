import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NativeVisualActivitySession } from "./native-visual-activity-session.ts";
import { setVisualActivityEnabledForTests } from "./visual-activity.ts";

afterEach(() => {
  setVisualActivityEnabledForTests(undefined);
});

describe("NativeVisualActivitySession", () => {
  it("bounds execution-card evaluation without changing single-step render deadlines", async () => {
    setVisualActivityEnabledForTests(true);
    const timeouts: Array<number | undefined> = [];
    const session = new NativeVisualActivitySession({
      async evaluateJson<T = unknown>(
        _expression: string,
        options?: { timeoutMs?: number },
      ): Promise<T> {
        timeouts.push(options?.timeoutMs);
        return true as T;
      },
    });
    await session.begin("单步观察");
    await session.showExecutionCard({
      ownerId: "run-one",
      epoch: 1,
      revision: 1,
      actionRevision: 0,
      title: "浏览器任务",
      stage: "正在查看页面",
      recent: [],
    });
    assert.deepEqual(timeouts, [undefined, 300]);
  });

  it("normalizes stale full-page viewport styles before showing the safe viewport frame", async () => {
    let renderedExpression = "";
    setVisualActivityEnabledForTests(true);

    const session = new NativeVisualActivitySession({
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        renderedExpression = expression;
        return true as T;
      },
    });

    const rendered = await session.begin("正在读取消息列表");

    assert.equal(rendered, true);
    assert.match(renderedExpression, /const normalizeActivityViewport = \(viewport\) =>/);
    assert.match(renderedExpression, /viewport\.style\.display = "none"/);
    assert.match(renderedExpression, /viewport\.style\.border = "0"/);
    assert.match(renderedExpression, /viewport\.style\.boxShadow = "none"/);
    assert.match(renderedExpression, /viewport\.style\.transform = "none"/);
    assert.match(
      renderedExpression,
      /const showActivityViewportFrame = \(viewport, theme, mode\) =>/,
    );
    assert.match(renderedExpression, /viewport\.style\.display = "block"/);
    assert.match(renderedExpression, /viewport\.style\.background =/);
    assert.match(renderedExpression, /linear-gradient\(180deg,/);
    assert.match(renderedExpression, /linear-gradient\(90deg,/);
    assert.match(renderedExpression, /"inset 0 0 0 2px " \+ theme\.accentSoft/);
    assert.match(renderedExpression, /inset 0 0 28px/);
    assert.doesNotMatch(renderedExpression, /viewport\.style\.inset = "10px"/);
    assert.doesNotMatch(renderedExpression, /viewport\.style\.borderRadius = "20px"/);
    assert.doesNotMatch(renderedExpression, /viewport\.style\.transform = "scale/);
    assert.doesNotMatch(renderedExpression, /0 0 52px/);
  });
});
