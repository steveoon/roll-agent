import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS,
  repairActiveToolProtocol,
  repairActiveToolProtocolEntries,
} from "./tool-protocol-repair.ts";

function toolCall(toolCallId: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName: "lookup", input: {} }],
  };
}

function toolResult(toolCallId: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "lookup",
        output: { type: "text", value: "ok" },
      },
    ],
  };
}

test("repairActiveToolProtocol 保留唯一且 call-before-result 的完整协议对", () => {
  const messages = [
    { role: "user", content: "查一下" },
    toolCall("call-1"),
    toolResult("call-1"),
  ] satisfies ModelMessage[];

  const repaired = repairActiveToolProtocol(messages);

  assert.equal(repaired.status, ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.valid);
  assert.deepEqual(repaired.messages, messages);
  assert.deepEqual(repaired.removedToolCallIds, []);
  assert.deepEqual(repaired.removedToolResultIds, []);
});

test("repairActiveToolProtocol 确定性移除 dangling/orphan，并保留同消息普通内容", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "先说明" },
        { type: "tool-call", toolCallId: "dangling", toolName: "lookup", input: {} },
      ],
    },
    toolResult("orphan"),
  ];

  const repaired = repairActiveToolProtocol(messages);

  assert.equal(repaired.status, ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.repaired);
  assert.deepEqual(repaired.messages, [
    { role: "assistant", content: [{ type: "text", text: "先说明" }] },
  ]);
  assert.deepEqual(repaired.removedToolCallIds, ["dangling"]);
  assert.deepEqual(repaired.removedToolResultIds, ["orphan"]);
});

test("repairActiveToolProtocol 对重复或 result-before-call 的歧义 ID 整组删除", () => {
  const repaired = repairActiveToolProtocol([
    toolCall("duplicate"),
    toolCall("duplicate"),
    toolResult("duplicate"),
    toolResult("reversed"),
    toolCall("reversed"),
    { role: "user", content: "继续" },
  ]);

  assert.equal(repaired.status, ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.repaired);
  assert.deepEqual(repaired.messages, [{ role: "user", content: "继续" }]);
  assert.deepEqual(repaired.removedToolCallIds, ["duplicate", "reversed"]);
  assert.deepEqual(repaired.removedToolResultIds, ["duplicate", "reversed"]);
});

test("repairActiveToolProtocolEntries 保留存活条目的关联元数据并剔除全空协议条目", () => {
  const entries = [
    { message: { role: "user", content: "开始" } satisfies ModelMessage, createdAt: "t0" },
    {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "部分保留" },
          { type: "tool-call", toolCallId: "dangling", toolName: "lookup", input: {} },
        ],
      } satisfies ModelMessage,
      createdAt: "t1",
    },
    { message: toolCall("valid"), createdAt: "t2" },
    { message: toolResult("orphan"), createdAt: "t3" },
    { message: toolResult("valid"), createdAt: "t4" },
  ];

  const repaired = repairActiveToolProtocolEntries(entries);

  assert.deepEqual(repaired, [
    { message: { role: "user", content: "开始" }, createdAt: "t0" },
    {
      message: { role: "assistant", content: [{ type: "text", text: "部分保留" }] },
      createdAt: "t1",
    },
    { message: toolCall("valid"), createdAt: "t2" },
    { message: toolResult("valid"), createdAt: "t4" },
  ]);
});

test("repairActiveToolProtocolEntries 保留元数据窄类型但将修复后的 message 宽化为 ModelMessage", () => {
  type NarrowAssistantTupleMessage = {
    readonly role: "assistant";
    readonly content: [
      { readonly type: "text"; readonly text: string },
      {
        readonly type: "tool-call";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly input: Record<string, never>;
      },
    ];
  };
  const narrowEntries: readonly {
    readonly createdAt: "2026-11-13T00:00:01.000Z";
    readonly message: NarrowAssistantTupleMessage;
  }[] = [
    {
      createdAt: "2026-11-13T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "仅保留文本" },
          { type: "tool-call", toolCallId: "dangling", toolName: "lookup", input: {} },
        ],
      },
    },
  ];

  const repaired = repairActiveToolProtocolEntries(narrowEntries);
  const first = repaired[0];
  assert.ok(first !== undefined);
  const preservedCreatedAt: "2026-11-13T00:00:01.000Z" = first.createdAt;
  const widenedMessage: ModelMessage = first.message;
  const expectNarrowTuple = (value: NarrowAssistantTupleMessage): NarrowAssistantTupleMessage =>
    value;
  // @ts-expect-error message 已被裁剪修复，返回类型不得继续承诺原始双元素 tuple
  expectNarrowTuple(first.message);

  assert.equal(preservedCreatedAt, "2026-11-13T00:00:01.000Z");
  assert.deepEqual(widenedMessage, {
    role: "assistant",
    content: [{ type: "text", text: "仅保留文本" }],
  });
});
