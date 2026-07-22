import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS,
  repairActiveToolProtocol,
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
