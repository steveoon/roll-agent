import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_EXECUTION_RECORD_VERSION,
  TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS,
  TOOL_EXECUTION_VALUE_ENCODINGS,
  createToolExecutionRecord,
  createToolExecutionRecordId,
  encodeToolExecutionValue,
  isToolExecutionRecordId,
  parseToolExecutionRecord,
  parseToolExecutionRecordId,
  toRedactedToolExecutionRecordSummary,
} from "./tool-execution-record.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

const RECORD_ID = "9d9bc41d-720d-4727-a570-446f14aab44c";

function result(overrides: Partial<NormalizedToolResult> = {}): NormalizedToolResult {
  return {
    raw: { content: [{ type: "text", text: "ok" }] },
    model: { type: "text", value: "ok" },
    display: "ok",
    outcome: { kind: "success" },
    output: "ok",
    isError: false,
    ...overrides,
  };
}

test("encodeToolExecutionValue 对 JSON MCP result 做无损可持久快照", () => {
  const raw = {
    content: [
      { type: "text", text: "visible" },
      { type: "resource", resource: { uri: "file:///tmp/a.txt", text: "body" } },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    structuredContent: { count: 2, nested: [true, null, "x"] },
    _meta: { requestId: "req-1", secret: "retained-in-raw" },
  };

  const encoded = encodeToolExecutionValue(raw);

  assert.equal(encoded.encoding, TOOL_EXECUTION_VALUE_ENCODINGS.json);
  assert.deepEqual(encoded.value, raw);
  assert.deepEqual(JSON.parse(JSON.stringify(encoded)), encoded);

  raw.structuredContent.nested[2] = "mutated";
  assert.deepEqual(encoded.value, {
    content: [
      { type: "text", text: "visible" },
      { type: "resource", resource: { uri: "file:///tmp/a.txt", text: "body" } },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    structuredContent: { count: 2, nested: [true, null, "x"] },
    _meta: { requestId: "req-1", secret: "retained-in-raw" },
  });
});

test("encodeToolExecutionValue 将 Error 变成带路径的可诊断 JSON fallback", () => {
  const encoded = encodeToolExecutionValue({ error: new TypeError("boom") });

  assert.equal(encoded.encoding, TOOL_EXECUTION_VALUE_ENCODINGS.diagnostic);
  assert.equal(encoded.diagnostics.length, 1);
  assert.equal(encoded.diagnostics[0]?.kind, TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.error);
  assert.equal(encoded.diagnostics[0]?.path, '$["error"]');
  assert.match(encoded.diagnostics[0]?.message ?? "", /TypeError: boom/u);
  assert.doesNotThrow(() => JSON.stringify(encoded));
});

test("encodeToolExecutionValue 区分 undefined、BigInt 与 cycle fallback", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const encoded = encodeToolExecutionValue({ missing: undefined, count: 42n, cyclic });

  assert.equal(encoded.encoding, TOOL_EXECUTION_VALUE_ENCODINGS.diagnostic);
  assert.deepEqual(
    encoded.diagnostics.map(({ kind, path, referencePath }) => ({
      kind,
      path,
      ...(referencePath !== undefined ? { referencePath } : {}),
    })),
    [
      { kind: "undefined", path: '$["missing"]' },
      { kind: "bigint", path: '$["count"]' },
      { kind: "cycle", path: '$["cyclic"]["self"]', referencePath: '$["cyclic"]' },
    ],
  );
  assert.doesNotThrow(() => JSON.stringify(encoded));
});

test("encodeToolExecutionValue 不把共享引用误判为循环引用", () => {
  const shared = { value: "same" };
  const encoded = encodeToolExecutionValue({ left: shared, right: shared });

  assert.equal(encoded.encoding, TOOL_EXECUTION_VALUE_ENCODINGS.json);
  assert.deepEqual(encoded.value, { left: { value: "same" }, right: { value: "same" } });
});

test("ToolExecutionRecord 使用版本化 UUID identity 并快照 input/raw/model/display/outcome", () => {
  const toolInput = { q: "before" };
  const raw = {
    content: [{ type: "text", text: "raw-before" }],
    structuredContent: { answer: 42 },
  };
  const model = { type: "json" as const, value: { answer: 42 } };
  const display = { summary: "before" };
  const outcome = { kind: "tool_failed" as const, reason: "retryable" };
  const normalized = result({ raw, model, display, outcome, isError: true });

  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-1",
    agentName: "demo-agent",
    toolName: "lookup",
    input: toolInput,
    result: normalized,
    createdAt: "2026-07-17T10:00:00.000Z",
  });

  toolInput.q = "after";
  raw.content[0]!.text = "raw-after";
  raw.structuredContent.answer = 0;
  model.value.answer = 0;
  display.summary = "after";
  outcome.reason = "changed";

  assert.equal(record.version, TOOL_EXECUTION_RECORD_VERSION);
  assert.equal(record.id, RECORD_ID);
  assert.equal(record.toolCallId, "call-1");
  assert.deepEqual(record.input.value, { q: "before" });
  assert.deepEqual(record.raw.value, {
    content: [{ type: "text", text: "raw-before" }],
    structuredContent: { answer: 42 },
  });
  assert.deepEqual(record.model, { type: "json", value: { answer: 42 } });
  assert.deepEqual(record.display.value, { summary: "before" });
  assert.deepEqual(record.outcome, { kind: "tool_failed", reason: "retryable" });
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test("ToolExecutionRecord UUID helpers 校验和生成 identity", () => {
  assert.equal(isToolExecutionRecordId(RECORD_ID), true);
  assert.equal(parseToolExecutionRecordId(RECORD_ID), RECORD_ID);
  assert.throws(() => parseToolExecutionRecordId("not-a-uuid"), /Invalid ToolExecutionRecord/u);
  assert.throws(
    () =>
      createToolExecutionRecord({
        id: "",
        toolCallId: "call-invalid-id",
        agentName: "demo-agent",
        toolName: "read",
        input: {},
        result: result(),
      }),
    /Invalid ToolExecutionRecord/u,
  );
  assert.equal(isToolExecutionRecordId(createToolExecutionRecordId()), true);
});

test("parseToolExecutionRecord validates a persisted JSON round-trip", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-roundtrip",
    agentName: "demo-agent",
    toolName: "read",
    input: { path: "/tmp/a" },
    result: result(),
  });
  assert.deepEqual(parseToolExecutionRecord(JSON.parse(JSON.stringify(record))), record);
  assert.throws(
    () => parseToolExecutionRecord({ ...record, outcome: { kind: "invented" } }),
    /Invalid persisted ToolExecutionRecord/u,
  );
});

test("parseToolExecutionRecord 拒绝对象属性中的 undefined", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-invalid-json",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result(),
  });

  assert.throws(
    () =>
      parseToolExecutionRecord({
        ...record,
        display: {
          version: 1,
          encoding: "json",
          value: { valid: true, nested: { missing: undefined } },
        },
      }),
    /Invalid persisted ToolExecutionRecord/u,
  );
});

test("toRedactedToolExecutionRecordSummary 默认隐藏 input/raw 并保留安全投影视图", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-secret",
    agentName: "demo-agent",
    toolName: "read",
    input: { token: "input-secret" },
    result: result({
      raw: { _meta: { token: "raw-secret" }, structuredContent: { answer: 42 } },
      model: { type: "json", value: { answer: 42 } },
      display: "answer=42",
    }),
    createdAt: "2026-07-17T10:00:00.000Z",
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.input, { version: 1, encoding: "redacted" });
  assert.deepEqual(summary.raw, { version: 1, encoding: "redacted" });
  assert.deepEqual(summary.model, { type: "json", value: { answer: 42 } });
  assert.deepEqual(summary.display.value, "answer=42");
  assert.deepEqual(summary.outcome, { kind: "success" });
  assert.equal(serialized.includes("input-secret"), false);
  assert.equal(serialized.includes("raw-secret"), false);
});

test("toRedactedToolExecutionRecordSummary 保留 display 的诊断状态", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-display-error",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({ display: new Error("display failed") }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);

  assert.equal(summary.display.encoding, TOOL_EXECUTION_VALUE_ENCODINGS.diagnostic);
  assert.equal(summary.display.diagnostics[0]?.kind, TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.error);
  assert.match(summary.display.diagnostics[0]?.message ?? "", /display failed/u);
});

test("toRedactedToolExecutionRecordSummary 清理 model/display 文本 secret 并保留摘要", () => {
  const modelSecret = "model-secret-token-123";
  const displaySecret = "display-secret-token-456";
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-secret-text",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({
      model: {
        type: "text",
        value: `status=ok Authorization: Bearer ${modelSecret}`,
      },
      display: `answer=42 token=${displaySecret}`,
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.model, {
    type: "text",
    value: "status=ok Authorization: [redacted]",
  });
  assert.equal(summary.display.value, "answer=42 token=[redacted]");
  assert.doesNotMatch(serialized, /model-secret-token|display-secret-token/u);
  assert.match(JSON.stringify(record), /model-secret-token|display-secret-token/u);
});

test("toRedactedToolExecutionRecordSummary 对 unquoted secret assignment 整行 fail closed", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-prefixed-secret",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({
      model: { type: "text", value: "MY_API_KEY=totally-secret-value visible=kept" },
      display:
        "service.api.key: another-secret-value\nstatus: ok\nnotatoken=public token_budget=100",
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.model, {
    type: "text",
    value: "MY_API_KEY=[redacted]",
  });
  assert.equal(
    summary.display.value,
    "service.api.key: [redacted]\nstatus: ok\nnotatoken=public token_budget=100",
  );
  assert.doesNotMatch(serialized, /totally-secret-value|another-secret-value/u);
  assert.doesNotMatch(serialized, /visible=kept/u);
});

test("toRedactedToolExecutionRecordSummary 统一识别 credential env 与 connection URI key", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-env-secret",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({
      model: {
        type: "text",
        value: [
          "AWS_SECRET_ACCESS_KEY=aws-secret-access-value",
          "AWS_ACCESS_KEY_ID=aws-access-key-id-value",
          "GOOGLE_APPLICATION_CREDENTIALS=/tmp/google-credential-secret.json",
          "DATABASE_URL=postgres://db-user:db-password@localhost/app",
          "PUBLIC_URL=https://public.example.com",
          "CALLBACK_URL=https://callback.example.com",
        ].join("\n"),
      },
      display:
        'env.DATABASE_URL="postgres://quoted-user:quoted-password@localhost/app" PUBLIC_URL=https://public.example.com',
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.doesNotMatch(
    serialized,
    /aws-secret-access-value|aws-access-key-id-value|google-credential-secret|db-password|quoted-password/u,
  );
  assert.match(serialized, /AWS_SECRET_ACCESS_KEY=\[redacted\]/u);
  assert.match(serialized, /AWS_ACCESS_KEY_ID=\[redacted\]/u);
  assert.match(serialized, /GOOGLE_APPLICATION_CREDENTIALS=\[redacted\]/u);
  assert.match(serialized, /DATABASE_URL=\[redacted\]/u);
  assert.match(serialized, /PUBLIC_URL=https:\/\/public\.example\.com/u);
  assert.match(serialized, /CALLBACK_URL=https:\/\/callback\.example\.com/u);
});

test("toRedactedToolExecutionRecordSummary 覆盖多词密码与 CJK key，保留非敏感 CJK 字段", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-cjk-secret",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({
      model: {
        type: "text",
        value: "password=my secret phrase visible=must-not-survive\nstatus=ok",
      },
      display: "数据库密码=中文机密 后半行仍属秘密\n密码学=cryptography\n访问令牌计数=3\nnote=kept",
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.model, {
    type: "text",
    value: "password=[redacted]\nstatus=ok",
  });
  assert.equal(
    summary.display.value,
    "数据库密码=[redacted]\n密码学=cryptography\n访问令牌计数=3\nnote=kept",
  );
  assert.doesNotMatch(serialized, /my secret phrase|must-not-survive|中文机密|后半行仍属秘密/u);
});

test("toRedactedToolExecutionRecordSummary 清理结构化 token 并保留非敏感字段", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-structured-secret",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({
      model: {
        type: "json",
        value: {
          answer: 42,
          apiToken: "model-structured-secret",
          nested: {
            password: "nested-password",
            密码: "中文结构秘密",
            密码提示: "kept-hint",
            note: "kept",
          },
        },
      },
      display: {
        summary: "ok",
        access_token: "display-structured-secret",
      },
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);

  assert.deepEqual(summary.model, {
    type: "json",
    value: {
      answer: 42,
      apiToken: "[redacted]",
      nested: {
        password: "[redacted]",
        密码: "[redacted]",
        密码提示: "kept-hint",
        note: "kept",
      },
    },
  });
  assert.deepEqual(summary.display.value, {
    summary: "ok",
    access_token: "[redacted]",
  });
  assert.doesNotMatch(
    JSON.stringify(summary),
    /model-structured-secret|nested-password|中文结构秘密|display-structured-secret/u,
  );
});

test("toRedactedToolExecutionRecordSummary 省略媒体 base64 并保留媒体摘要", () => {
  const mediaBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAusB9Y9ZQmc=";
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-media",
    agentName: "demo-agent",
    toolName: "render",
    input: {},
    result: result({
      model: {
        type: "content",
        value: [
          { type: "text", text: "render complete" },
          {
            type: "file",
            data: { type: "data", data: mediaBase64 },
            mediaType: "image/png",
            filename: "preview.png",
          },
        ],
      },
      display: { label: "preview", imageBase64: mediaBase64 },
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.model.type, "content");
  if (summary.model.type !== "content") {
    assert.fail("expected content model summary");
  }
  assert.deepEqual(summary.model.value, [
    { type: "text", text: "render complete" },
    {
      type: "file",
      data: { type: "data", data: `[binary content omitted: ${String(mediaBase64.length)} chars]` },
      mediaType: "image/png",
      filename: "preview.png",
    },
  ]);
  assert.deepEqual(summary.display.value, {
    label: "preview",
    imageBase64: `[binary content omitted: ${String(mediaBase64.length)} chars]`,
  });
  assert.equal(serialized.includes(mediaBase64), false);
  assert.equal(JSON.stringify(record).includes(mediaBase64), true);
});

test("toRedactedToolExecutionRecordSummary 对多行 quoted/block secret fail closed", () => {
  const quotedHead = "quoted-secret-head";
  const quotedTail = "quoted-secret-tail";
  const blockHead = "block-secret-head";
  const blockTail = "block-secret-tail";
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-multiline-secret",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({
      model: {
        type: "text",
        value: `status=ok token="${quotedHead}\n${quotedTail}" visible=kept`,
      },
      display: `password: |\n  ${blockHead}\n  ${blockTail}`,
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.model, {
    type: "text",
    value: "status=ok token=[redacted] visible=kept",
  });
  assert.equal(summary.display.value, "password: [redacted]");
  assert.doesNotMatch(serialized, /quoted-secret|block-secret/u);
  assert.match(JSON.stringify(record), /quoted-secret|block-secret/u);
});

test("toRedactedToolExecutionRecordSummary 对完整或截断 private key block fail closed", () => {
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-private-key",
    agentName: "demo-agent",
    toolName: "read",
    input: {},
    result: result({
      model: {
        type: "text",
        value:
          "key=\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-body\n-----END OPENSSH PRIVATE KEY-----\nvisible=kept",
      },
      display: "-----BEGIN PRIVATE KEY-----\ntruncated-private-body",
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.model, {
    type: "text",
    value: "key=\n[redacted]\nvisible=kept",
  });
  assert.equal(summary.display.value, "[redacted]");
  assert.doesNotMatch(serialized, /private-body|truncated-private-body/u);
});

test("toRedactedToolExecutionRecordSummary 省略换行折叠的内嵌 data URI", () => {
  const mediaHead = "QUFBQUFB";
  const mediaTail = "QkJCQkJC";
  const record = createToolExecutionRecord({
    id: RECORD_ID,
    toolCallId: "call-wrapped-data-uri",
    agentName: "demo-agent",
    toolName: "render",
    input: {},
    result: result({
      model: {
        type: "text",
        value: `preview data:image/png;base64,${mediaHead}\n  ${mediaTail} done`,
      },
      display: `thumbnail data:image/png;base64,${mediaHead}\\n${mediaTail} done`,
    }),
  });

  const summary = toRedactedToolExecutionRecordSummary(record);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.model.type, "text");
  if (summary.model.type !== "text") {
    assert.fail("expected text model summary");
  }
  assert.match(summary.model.value, /^preview \[binary content omitted: \d+ chars\] done$/u);
  assert.match(
    String(summary.display.value),
    /^thumbnail \[binary content omitted: \d+ chars\] done$/u,
  );
  assert.doesNotMatch(serialized, /QUFBQUFB|QkJCQkJC/u);
  assert.match(JSON.stringify(record), /QUFBQUFB|QkJCQkJC/u);
});
