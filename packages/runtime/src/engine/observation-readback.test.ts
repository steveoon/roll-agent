import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { normalizeToolResult } from "../tool-bridge/normalize-result.ts";
import {
  createToolExecutionRecord,
  prepareToolExecutionRecordForPersistence,
} from "../tool-bridge/tool-execution-record.ts";
import { readObservationPage } from "./observation-readback.ts";

const declaration = { kind: "browser-ax-snapshot" } as const;

function evidence(size = 1) {
  const value = {
    page: { url: "https://example.test" },
    snapshot: {
      snapshotId: "snapshot-a",
      browserInstance: "browser-a",
      pageId: "page-a",
      documentId: "document-a",
      nodes: Array.from({ length: size }, (_, index) => ({
        role: "textbox",
        name: `field-${index} apiKey=secret-value ${"x".repeat(size > 10 ? 2_000 : 0)}`,
        ref: `@e${index}`,
        depth: 0,
        ignored: false,
      })),
      refs: [],
      nodeCount: size,
      truncated: false,
      maxNodes: size,
      interactiveOnly: true,
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("按结果 ID 分页回查当前规范消息，脱敏且不复活旧 ref", () => {
  const raw = evidence(25);
  const record = createToolExecutionRecord({
    toolCallId: "call-a",
    agentName: "browser",
    toolName: "snapshot",
    input: {},
    result: normalizeToolResult(raw),
  });
  const messages: ModelMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-a",
          toolName: "browser__snapshot",
          output: { type: "content", value: [{ type: "text", text: raw.content[0]!.text }] },
        },
      ],
    },
  ];
  const first = readObservationPage(
    { resultId: record.id, limit: 10 },
    { ...record, sequence: 0 },
    messages,
    declaration,
  );
  const serialized = JSON.stringify(first);
  assert.match(serialized, /"nextAfterNode":9/u);
  assert.match(serialized, /"complete":true/u);
  assert.doesNotMatch(serialized, /secret-value/u);
  assert.doesNotMatch(serialized, /@e0/u);
  const second = readObservationPage(
    { resultId: record.id, afterNode: 9, limit: 10 },
    { ...record, sequence: 0 },
    messages,
    declaration,
  );
  assert.match(JSON.stringify(second), /field-10/u);
});

test("复用 toolCallId 的明确结果 ID 不会读到另一份活动快照", () => {
  const first = evidence(1);
  const secondValue = JSON.parse(first.content[0]!.text);
  secondValue.snapshot.snapshotId = "snapshot-b";
  secondValue.snapshot.nodes[0].name = "second-observation";
  const second = { content: [{ type: "text", text: JSON.stringify(secondValue) }] };
  const record = createToolExecutionRecord({
    toolCallId: "reused-id",
    agentName: "browser",
    toolName: "snapshot",
    input: {},
    result: normalizeToolResult(first),
  });
  const messages: ModelMessage[] = [first, second].map((raw) => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "reused-id",
        toolName: "browser__snapshot",
        output: { type: "content", value: [{ type: "text", text: raw.content[0]!.text }] },
      },
    ],
  }));
  const page = readObservationPage(
    { resultId: record.id },
    { ...record, sequence: 0 },
    messages,
    declaration,
  );
  assert.match(JSON.stringify(page), /snapshot-a/u);
  assert.doesNotMatch(JSON.stringify(page), /second-observation/u);
});

test("持久化原文被大小限制省略时回查明确报告不完整", () => {
  const large = evidence(1);
  const value = JSON.parse(large.content[0]!.text);
  value.snapshot.nodes = Array.from({ length: 100 }, (_, index) => ({
    role: "text",
    name: `ordinary-field-${index}-${"x".repeat(2_000)}`,
    depth: 0,
    ignored: false,
  }));
  const raw = { content: [{ type: "text", text: JSON.stringify(value) }] };
  const record = createToolExecutionRecord({
    toolCallId: "call-large",
    agentName: "browser",
    toolName: "snapshot",
    input: {},
    result: normalizeToolResult(raw),
  });
  const durable = prepareToolExecutionRecordForPersistence(record);
  assert.equal(durable.persistence.fields.raw.truncated, true);
  const page = readObservationPage(
    { resultId: record.id },
    { ...durable, sequence: 0 },
    [],
    declaration,
  );
  assert.deepEqual(page, {
    resultId: record.id,
    complete: false,
    reason: "durable_payload_truncated",
    refsAreStale: true,
    nodes: [],
  });
});
