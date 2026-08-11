import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_CANCELLATION_EXECUTION_STATES,
  TOOL_OUTCOME_KINDS,
  createToolResult,
  failedToolResult,
  isNormalizedToolResult,
  normalizeToolResult,
  readIsError,
  readToolOutcome,
  toolResultToModelOutput,
} from "./normalize-result.ts";

test("cancelled outcome 只接受兼容的结构化 executionState", () => {
  for (const executionState of Object.values(TOOL_CANCELLATION_EXECUTION_STATES)) {
    const result = createToolResult(
      {
        kind: TOOL_OUTCOME_KINDS.cancelled,
        reason: "user",
        executionState,
      },
      "cancelled",
    );
    assert.equal(isNormalizedToolResult(result), true);
    assert.deepEqual(readToolOutcome(result), {
      kind: TOOL_OUTCOME_KINDS.cancelled,
      reason: "user",
      executionState,
    });
  }

  assert.equal(
    isNormalizedToolResult(
      createToolResult({ kind: TOOL_OUTCOME_KINDS.cancelled }, "legacy cancelled"),
    ),
    true,
  );
  assert.equal(
    isNormalizedToolResult({
      ...createToolResult({ kind: TOOL_OUTCOME_KINDS.cancelled }, "invalid"),
      outcome: { kind: TOOL_OUTCOME_KINDS.cancelled, executionState: "invented" },
    }),
    false,
  );
  assert.equal(
    isNormalizedToolResult({
      ...createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, "invalid"),
      outcome: {
        kind: TOOL_OUTCOME_KINDS.success,
        executionState: TOOL_CANCELLATION_EXECUTION_STATES.notExecuted,
      },
    }),
    false,
  );
});

test("normalizeToolResult 提取 text content", () => {
  const result = normalizeToolResult({ content: [{ type: "text", text: "hello" }] });
  assert.equal(result.output, "hello");
  assert.equal(result.isError, false);
});

test("normalizeToolResult 拼接多段 text", () => {
  const result = normalizeToolResult({
    content: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  });
  assert.equal(result.output, "a\nb");
});

test("normalizeToolResult 标记 isError", () => {
  const result = normalizeToolResult({
    isError: true,
    content: [{ type: "text", text: "boom" }],
  });
  assert.equal(result.output, "boom");
  assert.equal(result.isError, true);
});

test("normalizeToolResult 无 text 时保留 raw，并生成有界 display", () => {
  const raw = { content: [{ type: "image", data: "x" }] };
  const result = normalizeToolResult(raw);
  assert.equal(result.raw, raw);
  assert.equal(result.display, "[image]");
  assert.equal(result.model.type, "text");
  assert.equal(result.isError, false);
});

test("readIsError 判定", () => {
  assert.equal(readIsError({ isError: true }), true);
  assert.equal(readIsError({ output: "x", isError: false }), false);
  assert.equal(readIsError("x"), false);
  assert.equal(readIsError(null), false);
});

test("normalizeToolResult 同时保留 MCP raw、multimodal model 与简洁 display", () => {
  const raw = {
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "resource_link", name: "doc", uri: "file:///tmp/doc.md" },
    ],
    structuredContent: { count: 2 },
    _meta: { privateTrace: "raw-only" },
  };

  const result = normalizeToolResult(raw);

  assert.equal(result.raw, raw);
  assert.equal(result.display, "hello");
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(result.model.type, "content");
  if (result.model.type === "content") {
    assert.ok(result.model.value.some((part) => part.type === "file"));
    assert.ok(
      result.model.value.some(
        (part) => part.type === "text" && part.text.includes("structuredContent"),
      ),
    );
    assert.doesNotMatch(JSON.stringify(result.model), /privateTrace/u);
  }
  assert.equal(toolResultToModelOutput(result), result.model);
});

test("normalizeToolResult 不把仅供 Harness 的 _meta 泄漏到 model/display", () => {
  const raw = {
    content: [],
    _meta: { apiToken: "secret-value", image: "base64-payload" },
  };

  const result = normalizeToolResult(raw);

  assert.equal(result.raw, raw);
  assert.doesNotMatch(JSON.stringify(result.model), /secret-value|base64-payload/u);
  assert.doesNotMatch(JSON.stringify(result.display), /secret-value|base64-payload/u);
  assert.match(String(result.display), /无可展示/u);
});

test("normalizeToolResult 投影 MCP task toolResult，但 raw 仍保留任务包装", () => {
  const raw = {
    toolResult: {
      content: [{ type: "text", text: "task completed" }],
      structuredContent: { count: 1 },
      _meta: { apiToken: "inner-task-secret" },
    },
    _meta: { taskId: "task-1" },
  };

  const result = normalizeToolResult(raw);

  assert.equal(result.raw, raw);
  assert.equal(result.display, "task completed");
  assert.equal(result.model.type, "content");
  assert.match(JSON.stringify(result.model), /task completed/u);
  assert.doesNotMatch(JSON.stringify(result.model), /task-1|inner-task-secret/u);
});

test("normalizeToolResult task wrapper fallback 不把内层 _meta 注入模型", () => {
  const result = normalizeToolResult({
    toolResult: {
      status: "completed",
      _meta: { apiToken: "INNER_TASK_SECRET" },
    },
  });

  assert.match(JSON.stringify(result.model), /completed/u);
  assert.doesNotMatch(JSON.stringify(result.model), /INNER_TASK_SECRET|apiToken/u);
});

test("normalizeToolResult 从 display 移除 structuredContent 中的二进制字段", () => {
  const result = normalizeToolResult({
    structuredContent: {
      title: "preview",
      image: "a".repeat(1_000),
      image_base64: "c".repeat(1_000),
      imageData: "e".repeat(1_000),
      image_data: "f".repeat(1_000),
      audioData: "g".repeat(1_000),
      binaryData: "h".repeat(1_000),
      nested: {
        _meta: { secret: "hidden" },
        data: "b".repeat(1_000),
        base64Data: "d".repeat(1_000),
      },
    },
  });
  const display = JSON.stringify(result.display);

  assert.match(display, /preview/u);
  assert.match(display, /binary content omitted/u);
  assert.doesNotMatch(display, /hidden|a{100}|b{100}|c{100}|d{100}|e{100}|f{100}|g{100}|h{100}/u);
});

test("normalizeToolResult 文本走统一预算而 media 走独立文件预算", () => {
  const result = normalizeToolResult({
    content: [
      { type: "text", text: "t".repeat(200_000) },
      { type: "image", data: "i".repeat(200_000), mimeType: "image/png" },
    ],
    structuredContent: { payload: "s".repeat(200_000) },
  });

  assert.equal(result.model.type, "content");
  if (result.model.type === "content") {
    const textChars = result.model.value.reduce(
      (total, part) => total + (part.type === "text" ? part.text.length : 0),
      0,
    );
    assert.ok(textChars <= 60_000, `actual text chars: ${String(textChars)}`);
    const imagePart = result.model.value.find((part) => part.type === "file");
    assert.ok(imagePart !== undefined, "image file part should survive model projection");
    if (imagePart !== undefined && imagePart.type === "file") {
      assert.equal(imagePart.data.data.length, 200_000);
    }
  }
  assert.equal(result.raw && typeof result.raw === "object", true);
});

test("normalizeToolResult 超出文件预算的 media 降级为标记文本", () => {
  const result = normalizeToolResult({
    content: [{ type: "image", data: "x".repeat(13_000_000), mimeType: "image/png" }],
  });

  assert.equal(result.model.type, "content");
  if (result.model.type === "content") {
    assert.equal(result.model.value.some((part) => part.type === "file"), false);
    const marker = result.model.value.find((part) => part.type === "text");
    assert.ok(marker !== undefined && marker.type === "text");
    if (marker !== undefined && marker.type === "text") {
      assert.match(marker.text, /file omitted from model projection/u);
    }
  }
});

test("normalizeToolResult 同时限制零字节 media part 数量", () => {
  const result = normalizeToolResult({
    content: Array.from({ length: 10_000 }, () => ({
      type: "image",
      data: "",
      mimeType: "image/png",
    })),
  });

  assert.equal(result.model.type, "content");
  if (result.model.type === "content") {
    assert.ok(
      result.model.value.length <= 129,
      `actual parts: ${String(result.model.value.length)}`,
    );
  }
  assert.ok(JSON.stringify(result.model).length <= 60_000);
});

test("类型化 outcome 不依赖本地化展示文案", () => {
  const denied = failedToolResult(TOOL_OUTCOME_KINDS.policyDenied, "任意展示文本", {
    reason: "blocked",
  });
  assert.equal(readToolOutcome(denied).kind, TOOL_OUTCOME_KINDS.policyDenied);
  assert.equal(readIsError(denied), true);
  assert.equal(denied.model.type, "error-json");
  assert.match(JSON.stringify(denied.model), /policy_denied/u);
});
