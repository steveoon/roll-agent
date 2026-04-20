import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTextContent, isToolErrorResult } from "./tool-results.ts";

describe("cli/utils/tool-results", () => {
  it("extracts only text content blocks", () => {
    const texts = extractTextContent([
      { type: "text", text: "first" },
      { type: "image", url: "https://example.com/demo.png" },
      { type: "text", text: "second" },
      null,
    ]);

    assert.deepEqual(texts, ["first", "second"]);
  });

  it("recognizes MCP tool results with isError=true", () => {
    assert.equal(isToolErrorResult({ isError: true, content: [] }), true);
    assert.equal(isToolErrorResult({ isError: false, content: [] }), false);
    assert.equal(isToolErrorResult({ content: [] }), false);
    assert.equal(isToolErrorResult(null), false);
  });
});
