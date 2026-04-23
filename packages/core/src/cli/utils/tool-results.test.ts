import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractTextContent,
  formatToolResultForJsonOutput,
  isToolErrorResult,
} from "./tool-results.ts";

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

  it("unwraps SDK JSON text content for --json output", () => {
    const result = formatToolResultForJsonOutput({
      content: [{ type: "text", text: '{"signedEnvelope":"payload.signature","ok":true}' }],
    });

    assert.deepEqual(result, { signedEnvelope: "payload.signature", ok: true });
  });

  it("falls back to the raw MCP result when text content is not JSON", () => {
    const result = { content: [{ type: "text", text: "plain text response" }] };

    assert.deepEqual(formatToolResultForJsonOutput(result), result);
  });
});
