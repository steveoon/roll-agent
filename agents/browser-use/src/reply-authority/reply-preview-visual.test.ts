import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setVisualActivityEnabledForTests } from "../visual-activity.ts";
import { NativeReplyPreviewVisualSession } from "./reply-preview-visual.ts";

afterEach(() => {
  setVisualActivityEnabledForTests(undefined);
});

describe("NativeReplyPreviewVisualSession", () => {
  it("renders a loading spinner in the preview title while generating", async () => {
    let renderedExpression = "";
    setVisualActivityEnabledForTests(true);

    const session = new NativeReplyPreviewVisualSession({
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        renderedExpression = expression;
        return true as T;
      },
    });

    const rendered = await session.begin("开始分析对话意图");

    assert.equal(rendered, true);
    assert.match(renderedExpression, /roll-agent-reply-preview-spinner/);
    assert.match(renderedExpression, /rollAgentReplyPreviewSpin/);
  });

  it("renders location summary chips when provided", async () => {
    let renderedExpression = "";
    setVisualActivityEnabledForTests(true);

    const session = new NativeReplyPreviewVisualSession({
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        renderedExpression = expression;
        return true as T;
      },
    });

    const rendered = await session.begin("正在生成回复", "已识别地点：阳坊、北京（弱）");

    assert.equal(rendered, true);
    assert.match(renderedExpression, /roll-agent-reply-preview-location/);
    assert.match(renderedExpression, /已识别地点：阳坊、北京（弱）/);
    assert.match(renderedExpression, /location\.style\.display = "flex"/);
  });

  it("hides stale location summary when a new preview begins without one", async () => {
    let renderedExpression = "";
    setVisualActivityEnabledForTests(true);

    const session = new NativeReplyPreviewVisualSession({
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        renderedExpression = expression;
        return true as T;
      },
    });

    const rendered = await session.begin("正在生成回复");

    assert.equal(rendered, true);
    assert.match(renderedExpression, /input\.mode === "begin"/);
    assert.match(renderedExpression, /location\.textContent = ""/);
    assert.match(renderedExpression, /location\.style\.display = "none"/);
  });

  it("cancels delayed clear removal when reusing the preview root", async () => {
    let renderedExpression = "";
    setVisualActivityEnabledForTests(true);

    const session = new NativeReplyPreviewVisualSession({
      async evaluateJson<T = unknown>(expression: string): Promise<T> {
        renderedExpression = expression;
        return true as T;
      },
    });

    const rendered = await session.begin("正在生成回复", "已识别地点：阳坊");

    assert.equal(rendered, true);
    assert.match(renderedExpression, /cancelPendingRemove/);
    assert.match(renderedExpression, /state\.removeTimer/);
  });
});
