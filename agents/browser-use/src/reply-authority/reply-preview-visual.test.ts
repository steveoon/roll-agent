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
});
