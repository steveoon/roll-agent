import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRelayRequestParamsForVersion,
  parseRelayRequestResultForVersion,
  relayMessageSchemaV11,
  relayMessageSchemaV12,
  projectRelayMessageV12ToV11,
} from "./index.ts";

const params = {
  threadId: "00000000-0000-4000-8000-000000000002",
  operationId: "00000000-0000-4000-8000-000000000003",
};
test("Wire 1.2 query and results preserve business JSON; Wire 1.1 rejects the method", () => {
  const request = {
    type: "runtime.request",
    requestId: "00000000-0000-4000-8000-000000000004",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    method: "operation.result.get",
    params,
  };
  assert.equal(relayMessageSchemaV12.safeParse(request).success, true);
  assert.equal(relayMessageSchemaV11.safeParse(request).success, false);
  assert.deepEqual(
    parseRelayRequestParamsForVersion("1.2", "operation.result.get", params),
    params,
  );
  const result = {
    result: {
      ...params,
      agentName: "example",
      toolName: "search",
      createdAt: new Date(0).toISOString(),
      output: {
        status: "available",
        schemaId: "example.candidates",
        schemaVersion: 1,
        remoteReadable: true,
        data: { 中文: [{}, 0, []] },
        fallbackText: "data",
      },
    },
  };
  assert.deepEqual(
    parseRelayRequestResultForVersion("1.2", "operation.result.get", result),
    result,
  );
});
test("Wire 1.2 completion carries metadata and downgrades without data or descriptors", () => {
  const frame = relayMessageSchemaV12.parse({
    type: "runtime.event",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    relaySequence: 0,
    event: {
      protocolVersion: "1.1",
      runtimeInstanceId: "00000000-0000-4000-8000-000000000007",
      sequence: 0,
      timestamp: new Date(0).toISOString(),
      threadId: params.threadId,
      event: {
        type: "tool.completed",
        toolCallId: "call",
        agentName: "example",
        toolName: "search",
        operationId: params.operationId,
        appOutput: { status: "available", schemaId: "example.candidates", schemaVersion: 1 },
      },
    },
  });
  assert.ok(frame.type === "runtime.event");
  const legacy = projectRelayMessageV12ToV11(frame);
  assert.equal(relayMessageSchemaV11.safeParse(legacy).success, true);
  assert.equal(JSON.stringify(legacy).includes("appOutput"), false);
  assert.equal(
    relayMessageSchemaV12.safeParse({
      ...frame,
      event: { ...frame.event, event: { ...frame.event.event, data: { secret: true } } },
    }).success,
    false,
  );
});

test("Companion V12 snapshots downgrade to strict V11 snapshots", async () => {
  const { projectRelayThreadSnapshotV12, projectRelayThreadSnapshotV11 } =
    await import("./index.ts");
  const at = new Date(0).toISOString();
  const runtime = {
    thread: { id: params.threadId, createdAt: at, updatedAt: at, messageCount: 0 },
    messages: { items: [], nextBeforeSequence: null },
    operations: {
      items: [
        {
          id: params.operationId,
          sequence: 0,
          toolCallId: "call",
          agentName: "example",
          toolName: "search",
          createdAt: at,
          outcome: { kind: "success" },
          display: "private",
          appOutput: { status: "available", schemaId: "example.candidates", schemaVersion: 1 },
        },
      ],
      nextBeforeSequence: null,
    },
    pendingApprovals: [],
    pendingInteractions: [],
    eventCursor: null,
    transcriptCompleteness: "complete",
  };
  const relay = projectRelayThreadSnapshotV12(runtime);
  const legacy = projectRelayThreadSnapshotV11(relay);
  assert.deepEqual(legacy, projectRelayThreadSnapshotV11(runtime));
  assert.equal(legacy.operations.items[0]?.display, null);
  assert.equal("appOutput" in legacy.operations.items[0]!, false);
  assert.throws(() => projectRelayThreadSnapshotV11({ ...relay, raw: "unexpected" }));
});
