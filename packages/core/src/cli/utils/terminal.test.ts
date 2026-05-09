import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import {
  formatLocationForDisplay,
  indentBlock,
  normalizeTerminalColumns,
  truncateMiddle,
} from "./terminal.ts";

describe("cli/utils/terminal", () => {
  it("resolves terminal columns from stream, env, and default fallback", () => {
    assert.equal(normalizeTerminalColumns(100, "120"), 100);
    assert.equal(normalizeTerminalColumns(undefined, "96"), 96);
    assert.equal(normalizeTerminalColumns(undefined, "invalid"), 120);
    assert.equal(normalizeTerminalColumns(40, undefined), 80);
  });

  it("truncates long text in the middle", () => {
    assert.equal(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 10), "abcde…wxyz");
    assert.equal(truncateMiddle("short", 10), "short");
    assert.equal(truncateMiddle("abc", 1), "…");
  });

  it("compacts home paths before truncating locations", () => {
    const location = `${homedir()}/Documents/react-projects/Next-PJ/nano-agent/agents/browser-use`;
    const displayed = formatLocationForDisplay(location, 32);

    assert.match(displayed, /^~\//);
    assert.ok(displayed.length <= 32);
  });

  it("keeps urls intact unless truncation is required", () => {
    assert.equal(
      formatLocationForDisplay("http://127.0.0.1:3100/mcp", 80),
      "http://127.0.0.1:3100/mcp",
    );
  });

  it("indents every line in a block", () => {
    assert.equal(indentBlock("a\nb", 2), "  a\n  b");
  });
});
