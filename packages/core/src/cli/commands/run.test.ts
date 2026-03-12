import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseToolArgs } from "./run.ts";

describe("parseToolArgs", () => {
  it("should parse regular tool args", () => {
    const parsed = parseToolArgs(["boss-reply-agent", "get_unread", "--limit", "10", "--dryRun"]);
    assert.deepEqual(parsed, { limit: 10, dryRun: true });
  });

  it("should not pass --json to tool input", () => {
    const parsed = parseToolArgs([
      "boss-reply-agent",
      "get_unread",
      "--json",
      "--limit",
      "10",
    ]);
    assert.deepEqual(parsed, { limit: 10 });
  });

  it("should not pass --verbose to tool input", () => {
    const parsed = parseToolArgs([
      "boss-reply-agent",
      "get_unread",
      "--verbose",
      "--limit",
      "10",
    ]);
    assert.deepEqual(parsed, { limit: 10 });
  });

  it("should not pass --config and its value to tool input", () => {
    const parsed = parseToolArgs([
      "boss-reply-agent",
      "get_unread",
      "--config",
      "./roll.config.yaml",
      "--limit",
      "10",
    ]);
    assert.deepEqual(parsed, { limit: 10 });
  });
});
