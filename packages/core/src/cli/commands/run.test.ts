import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseExplicitToolInput, parseToolArgs, resolveToolArgs } from "./run.ts";

describe("parseToolArgs", () => {
  it("should parse regular tool args", () => {
    const parsed = parseToolArgs(["boss-reply-agent", "get_unread", "--limit", "10", "--dryRun"]);
    assert.deepEqual(parsed, { limit: 10, dryRun: true });
  });

  it("should not pass --json to tool input", () => {
    const parsed = parseToolArgs(["boss-reply-agent", "get_unread", "--json", "--limit", "10"]);
    assert.deepEqual(parsed, { limit: 10 });
  });

  it("should not pass --verbose to tool input", () => {
    const parsed = parseToolArgs(["boss-reply-agent", "get_unread", "--verbose", "--limit", "10"]);
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

  it("should not pass --input-json and its value to tool input", () => {
    const parsed = parseToolArgs([
      "boss-reply-agent",
      "get_unread",
      "--input-json",
      '{"metadata":{"foo":"bar"}}',
      "--limit",
      "10",
    ]);
    assert.deepEqual(parsed, { limit: 10 });
  });

  it("should not pass --input-file and its value to tool input", () => {
    const parsed = parseToolArgs([
      "boss-reply-agent",
      "get_unread",
      "--input-file",
      "./payload.json",
      "--limit",
      "10",
    ]);
    assert.deepEqual(parsed, { limit: 10 });
  });
});

describe("parseExplicitToolInput", () => {
  it("should parse --input-json as a JSON object", () => {
    const parsed = parseExplicitToolInput([
      "boss-reply-agent",
      "sync_config",
      "--input-json",
      '{"metadata":{"foo":"bar"}}',
    ]);
    assert.deepEqual(parsed, { metadata: { foo: "bar" } });
  });

  it("should parse --input-file as a JSON object", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-run-"));
    const filePath = join(dir, "payload.json");
    writeFileSync(filePath, '{"metadata":{"foo":"bar"}}');

    const parsed = parseExplicitToolInput([
      "boss-reply-agent",
      "sync_config",
      "--input-file",
      filePath,
    ]);
    assert.deepEqual(parsed, { metadata: { foo: "bar" } });
  });

  it("should parse a third positional JSON object as explicit tool input", () => {
    const parsed = parseExplicitToolInput([
      "browser-use-agent",
      "zhipin_open_chat",
      '{"conversationId":"541920402-0"}',
      "--json",
    ]);

    assert.deepEqual(parsed, { conversationId: "541920402-0" });
  });

  it("should reject using --input-json and --input-file together", () => {
    assert.throws(
      () =>
        parseExplicitToolInput([
          "boss-reply-agent",
          "sync_config",
          "--input-json",
          '{"metadata":{"foo":"bar"}}',
          "--input-file",
          "./payload.json",
        ]),
      /不能同时使用 positional JSON、--input-json 和 --input-file/,
    );
  });

  it("should reject positional JSON together with --input-json", () => {
    assert.throws(
      () =>
        parseExplicitToolInput([
          "browser-use-agent",
          "zhipin_open_chat",
          '{"conversationId":"541920402-0"}',
          "--input-json",
          '{"conversationId":"another"}',
        ]),
      /不能同时使用 positional JSON、--input-json 和 --input-file/,
    );
  });

  it("should reject extra non-json positional arguments", () => {
    assert.throws(
      () =>
        parseExplicitToolInput([
          "browser-use-agent",
          "zhipin_open_chat",
          "conversationId=541920402-0",
        ]),
      /只接受 agent\/tool 两个位置参数/,
    );
  });
});

describe("resolveToolArgs", () => {
  it("should merge explicit JSON input with flag args", () => {
    const parsed = resolveToolArgs([
      "boss-reply-agent",
      "sync_config",
      "--input-json",
      '{"metadata":{"foo":"bar"}}',
      "--limit",
      "10",
    ]);
    assert.deepEqual(parsed, {
      metadata: { foo: "bar" },
      limit: 10,
    });
  });

  it("should merge positional JSON input with flag args", () => {
    const parsed = resolveToolArgs([
      "browser-use-agent",
      "zhipin_open_chat",
      '{"conversationId":"541920402-0"}',
      "--preferUnread",
    ]);

    assert.deepEqual(parsed, {
      conversationId: "541920402-0",
      preferUnread: true,
    });
  });
});
