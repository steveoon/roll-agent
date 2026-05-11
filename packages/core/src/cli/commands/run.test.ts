import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBatchInput, parseExplicitToolInput, parseToolArgs, resolveToolArgs } from "./run.ts";

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

  it("should not pass batch options to tool input", () => {
    const parsed = parseToolArgs([
      "boss-reply-agent",
      "get_unread",
      "--batch-json",
      '[{"agent":"boss-reply-agent","tool":"get_unread"}]',
      "--batch-stdin",
      "--bail",
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

describe("parseBatchInput", () => {
  it("should parse --batch-json as a batch item array", () => {
    const parsed = parseBatchInput([
      "--batch-json",
      '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list","input":{"limit":2},"label":"list"}]',
    ]);

    assert.deepEqual(parsed, [
      {
        agent: "browser-use-agent",
        tool: "zhipin_get_candidate_list",
        input: { limit: 2 },
        label: "list",
      },
    ]);
  });

  it("should default missing item input to an empty object", () => {
    const parsed = parseBatchInput([
      "--batch-json",
      '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list"}]',
    ]);

    assert.deepEqual(parsed, [
      { agent: "browser-use-agent", tool: "zhipin_get_candidate_list", input: {} },
    ]);
  });

  it("should parse --batch-file as a batch item array", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-run-batch-"));
    const filePath = join(dir, "batch.json");
    writeFileSync(
      filePath,
      '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list","input":{"limit":1}}]',
    );

    const parsed = parseBatchInput(["--batch-file", filePath]);
    assert.deepEqual(parsed, [
      {
        agent: "browser-use-agent",
        tool: "zhipin_get_candidate_list",
        input: { limit: 1 },
      },
    ]);
  });

  it("should parse --batch-stdin as a batch item array", () => {
    const parsed = parseBatchInput(["--batch-stdin"], {
      readStdin: () =>
        '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list","input":{"limit":3}}]',
    });

    assert.deepEqual(parsed, [
      {
        agent: "browser-use-agent",
        tool: "zhipin_get_candidate_list",
        input: { limit: 3 },
      },
    ]);
  });

  it("should reject using multiple batch sources together", () => {
    assert.throws(
      () =>
        parseBatchInput([
          "--batch-json",
          '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list"}]',
          "--batch-file",
          "./batch.json",
        ]),
      /不能同时使用 --batch-json、--batch-file 和 --batch-stdin/,
    );

    assert.throws(
      () =>
        parseBatchInput([
          "--batch-json",
          '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list"}]',
          "--batch-stdin",
        ]),
      /不能同时使用 --batch-json、--batch-file 和 --batch-stdin/,
    );
  });

  it("should reject batch input together with single-call explicit input", () => {
    assert.throws(
      () =>
        parseBatchInput([
          "--batch-json",
          '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list"}]',
          "--input-json",
          '{"limit":1}',
        ]),
      /batch 模式不能同时使用 --input-json 或 --input-file/,
    );
  });

  it("should reject --batch-stdin without a stdin reader", () => {
    assert.throws(() => parseBatchInput(["--batch-stdin"]), /需要可用的 stdin 读取器/);
  });

  it("should reject non-object item input", () => {
    assert.throws(
      () =>
        parseBatchInput([
          "--batch-json",
          '[{"agent":"browser-use-agent","tool":"zhipin_get_candidate_list","input":[]}]',
        ]),
      /batch\[0\]\.input 必须是 JSON object/,
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
