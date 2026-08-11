import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { relocateToolImagesToUserMessages } from "./relocate-tool-images.ts";

function toolMessageWithImage(): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "zhipin_capture_resume",
        output: {
          type: "content",
          value: [
            { type: "text", text: '{"success":true}' },
            { type: "file", data: { type: "data", data: "aW1hZ2U=" }, mediaType: "image/png" },
          ],
        },
      },
    ],
  } as unknown as ModelMessage;
}

describe("relocateToolImagesToUserMessages", () => {
  it("moves tool-result image parts into a following user message", () => {
    const result = relocateToolImagesToUserMessages([toolMessageWithImage()]);

    assert.equal(result.length, 2);
    const [toolMessage, userMessage] = result;
    assert.ok(toolMessage !== undefined && userMessage !== undefined);
    assert.equal(toolMessage.role, "tool");
    const output = (toolMessage.content as Array<Record<string, unknown>>)[0]?.["output"] as {
      value: Array<Record<string, unknown>>;
    };
    assert.equal(
      output.value.some((part) => part["type"] === "file"),
      false,
    );
    assert.equal(userMessage.role, "user");
    const userParts = userMessage.content as unknown as Array<Record<string, unknown>>;
    const filePart = userParts.find((part) => part["type"] === "file");
    assert.ok(filePart !== undefined);
    assert.equal(filePart["data"], "aW1hZ2U=");
    assert.equal(filePart["mediaType"], "image/png");
  });

  it("is idempotent for already relocated messages", () => {
    const once = relocateToolImagesToUserMessages([toolMessageWithImage()]);
    const twice = relocateToolImagesToUserMessages(once);
    assert.deepEqual(twice, once);
  });

  it("passes through messages without tool images untouched", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    assert.deepEqual(relocateToolImagesToUserMessages(messages), messages);
  });
});
