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

  it("drops images from stale relocated messages keeping the most recent two", () => {
    const result = relocateToolImagesToUserMessages([
      toolMessageWithImage(),
      toolMessageWithImage(),
      toolMessageWithImage(),
    ]);

    const relocated = result.filter(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    assert.equal(relocated.length, 3);
    const [stale, ...fresh] = relocated;
    assert.ok(stale !== undefined);
    const staleParts = stale.content as unknown as Array<Record<string, unknown>>;
    assert.equal(
      staleParts.some((part) => part["type"] === "file"),
      false,
    );
    assert.ok(
      staleParts.some((part) => part["type"] === "text" && part["text"] === "[历史工具图像已省略]"),
    );
    for (const message of fresh) {
      const parts = message.content as unknown as Array<Record<string, unknown>>;
      assert.equal(
        parts.some((part) => part["type"] === "file"),
        true,
      );
    }
  });

  it("keeps stale-image trimming idempotent", () => {
    const once = relocateToolImagesToUserMessages([
      toolMessageWithImage(),
      toolMessageWithImage(),
      toolMessageWithImage(),
    ]);
    const twice = relocateToolImagesToUserMessages(once);
    assert.deepEqual(twice, once);
  });

  it("never touches user-authored image messages", () => {
    const userImageMessage: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "帮我看看这张截图" },
        { type: "file", data: "dXNlcg==", mediaType: "image/png" },
      ],
    } as unknown as ModelMessage;

    const result = relocateToolImagesToUserMessages([
      userImageMessage,
      toolMessageWithImage(),
      toolMessageWithImage(),
      toolMessageWithImage(),
    ]);

    const first = result[0];
    assert.ok(first !== undefined);
    const parts = first.content as unknown as Array<Record<string, unknown>>;
    assert.equal(
      parts.some((part) => part["type"] === "file" && part["data"] === "dXNlcg=="),
      true,
    );
  });

  it("keeps user messages whose text collides with the relocation prefix", () => {
    const collidingUserMessage: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "以下图像来自工具 别人发我的，帮我看看" },
        { type: "file", data: "Y29sbGlkZQ==", mediaType: "image/png" },
      ],
    } as unknown as ModelMessage;

    const result = relocateToolImagesToUserMessages([
      collidingUserMessage,
      toolMessageWithImage(),
      toolMessageWithImage(),
      toolMessageWithImage(),
    ]);

    const first = result[0];
    assert.ok(first !== undefined);
    const parts = first.content as unknown as Array<Record<string, unknown>>;
    assert.equal(
      parts.some((part) => part["type"] === "file" && part["data"] === "Y29sbGlkZQ=="),
      true,
    );
  });

  it("counts marker-tagged messages from a previous step toward stale trimming", () => {
    const previousStep = relocateToolImagesToUserMessages([toolMessageWithImage()]);
    const nextStepInput = [...previousStep, toolMessageWithImage(), toolMessageWithImage()];

    const result = relocateToolImagesToUserMessages(nextStepInput);

    const oldest = result.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    assert.ok(oldest !== undefined);
    const oldestParts = oldest.content as unknown as Array<Record<string, unknown>>;
    assert.equal(
      oldestParts.some((part) => part["type"] === "file"),
      false,
    );
    assert.ok(
      oldestParts.some(
        (part) => part["type"] === "text" && part["text"] === "[历史工具图像已省略]",
      ),
    );
  });
});
