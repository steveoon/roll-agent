import assert from "node:assert/strict";
import test from "node:test";
import { APP_OUTPUT_LIMITS, type AppOutputContract } from "@roll-agent/protocol";
import { normalizeToolResult } from "./normalize-result.ts";
import { executeWithToolApproval } from "./tool-approval-continuation.ts";
import type { ToolBridgeContext } from "./build-tools.ts";

const contract: AppOutputContract = {
  schemaId: "demo.candidates",
  schemaVersion: 1,
  remoteReadable: false,
  outputSchema: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" } } },
    required: ["names"],
    additionalProperties: false,
  },
};
const content = [{ type: "text", text: "Found candidates" }];

test("opt-in app output uses structuredContent and independently validates JSON schema", () => {
  const data = { names: ["李明", "Ada"] };
  const result = { content, structuredContent: data };
  assert.equal(normalizeToolResult(result).appOutput, undefined);
  assert.deepEqual(normalizeToolResult(result, contract).appOutput, {
    status: "available",
    schemaId: contract.schemaId,
    schemaVersion: 1,
    remoteReadable: false,
    data,
    fallbackText: "Found candidates",
  });
  assert.deepEqual(
    normalizeToolResult({ content: [{ type: "text", text: JSON.stringify(data) }] }, contract)
      .appOutput,
    { status: "invalid" },
  );
  assert.deepEqual(
    normalizeToolResult({ content, structuredContent: { names: [5] } }, contract).appOutput,
    { status: "invalid" },
  );
  assert.deepEqual(
    normalizeToolResult(
      { content, structuredContent: { names: ["中".repeat(APP_OUTPUT_LIMITS.resultBytes / 3)] } },
      contract,
    ).appOutput,
    { status: "too_large" },
  );
  assert.deepEqual(
    normalizeToolResult(result, {
      ...contract,
      outputSchema: { type: "object", $ref: "https://example.invalid/schema" },
    }).appOutput,
    { status: "invalid" },
  );
});

test("same schema id on independent tools never reuses another compiled schema", () => {
  const first = { ...contract, outputSchema: { $id: "same", type: "object", required: ["a"] } };
  const second = { ...contract, outputSchema: { $id: "same", type: "object", required: ["b"] } };
  assert.equal(
    normalizeToolResult({ content, structuredContent: { a: 1 } }, first).appOutput?.status,
    "available",
  );
  assert.equal(
    normalizeToolResult({ content, structuredContent: { a: 1 } }, second).appOutput?.status,
    "invalid",
  );
});

test("post-effect invalid output stays a completed execution without retry or approval", async () => {
  let calls = 0;
  const marker = {
    content,
    isError: true,
    _meta: { "roll/executionStatus": "completed", "roll/appOutputStatus": "invalid" },
  };
  assert.equal(normalizeToolResult(marker).outcome.kind, "tool_failed");
  assert.equal(
    normalizeToolResult(
      { content, isError: true, _meta: { "roll/appOutputStatus": "invalid" } },
      contract,
    ).outcome.kind,
    "tool_failed",
  );
  const ctx: ToolBridgeContext = {
    requestApproval: async () => {
      throw new Error("must not request approval");
    },
  };
  const result = await executeWithToolApproval({
    input: {},
    agentName: "demo",
    agentTool: { name: "candidates", inputSchema: { type: "object" }, appOutput: contract },
    annotations: undefined,
    ctx,
    signal: undefined,
    call: async () => {
      calls++;
      return marker;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome.kind, "success");
  assert.equal(result.isError, false);
  assert.deepEqual(result.appOutput, { status: "invalid" });
});
