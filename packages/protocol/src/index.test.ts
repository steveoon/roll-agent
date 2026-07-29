import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  initializeParamsSchema,
  operationGetResultSchema,
  runtimeEventEnvelopeSchema,
  runtimeMethodSchemas,
  runtimeProtocolErrorDataSchema,
  threadSnapshotSchema,
} from "./index.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000001",
  thread: "00000000-0000-4000-8000-000000000002",
  turn: "00000000-0000-4000-8000-000000000003",
  stream: "00000000-0000-4000-8000-000000000004",
} as const;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/v1/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

test("initialize schema negotiates protocol v1 without Node-specific data", () => {
  const parsed = initializeParamsSchema.parse({
    protocolVersions: [RUNTIME_PROTOCOL_VERSION],
    client: { name: "fixture-client", version: "1.0.0" },
  });
  assert.equal(parsed.protocolVersions[0], "1.0");
  assert.equal(RUNTIME_EVENT_NOTIFICATION, "runtime.event");
});

test("runtime method registry exposes the complete v1 surface", () => {
  assert.deepEqual(Object.keys(runtimeMethodSchemas).sort(), Object.values(RUNTIME_METHODS).sort());
  assert.throws(() =>
    runtimeMethodSchemas[RUNTIME_METHODS.turnStart].params.parse({
      requestId: IDS.turn,
      threadId: IDS.thread,
      turnId: "not-a-uuid",
      input: { text: "hello" },
    }),
  );
});

test("runtime event envelope is ordered by runtime instance and sequence", () => {
  const parsed = runtimeEventEnvelopeSchema.parse({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: IDS.runtime,
    sequence: 7,
    timestamp: "2026-07-28T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event: {
      type: "message.delta",
      streamId: IDS.stream,
      delta: "hello",
    },
  });
  assert.equal(parsed.sequence, 7);
  assert.equal(parsed.event.type, "message.delta");
});

test("thread snapshot never exposes raw Tool evidence fields", () => {
  const snapshot = threadSnapshotSchema.parse({
    thread: {
      id: IDS.thread,
      title: "demo",
      model: "mock",
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
      messageCount: 1,
    },
    messages: {
      items: [
        {
          sequence: 0,
          role: "user",
          createdAt: "2026-07-28T12:00:00.000Z",
          parts: [{ type: "text", text: "hello" }],
        },
      ],
      nextBeforeSequence: null,
    },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    transcriptCompleteness: "complete",
  });
  assert.equal(snapshot.messages.items[0]?.parts[0]?.text, "hello");
  assert.equal("raw" in snapshot.operations, false);
});

test("structured error data requires a stable Roll error code", () => {
  assert.equal(
    runtimeProtocolErrorDataSchema.parse({
      rollCode: "THREAD_NOT_FOUND",
      retryable: false,
    }).rollCode,
    "THREAD_NOT_FOUND",
  );
  assert.throws(() =>
    runtimeProtocolErrorDataSchema.parse({
      rollCode: "UNKNOWN",
      retryable: false,
    }),
  );
});

test("cross-language golden fixtures keep request, response and event compatibility", () => {
  const initialize = fixture("valid-initialize-request.json");
  assert.equal(initializeParamsSchema.parse(initialize.params).client.name, "golden-client");

  const snapshot = fixture("valid-thread-snapshot-response.json");
  assert.equal(
    threadSnapshotSchema.parse(snapshot.result).messages.items[0]?.parts[0]?.text,
    "hello",
  );

  const event = fixture("valid-runtime-event-notification.json");
  assert.equal(runtimeEventEnvelopeSchema.parse(event.params).sequence, 7);

  const invalidTurn = fixture("invalid-turn-start-request.json");
  assert.throws(() =>
    runtimeMethodSchemas[RUNTIME_METHODS.turnStart].params.parse(invalidTurn.params),
  );

  const invalidOperation = fixture("invalid-operation-raw-response.json");
  assert.throws(() => operationGetResultSchema.parse(invalidOperation.result));
});

test("cross-language event fixtures reject invalid process-local ordering", () => {
  const invalidEvent = fixture("invalid-runtime-event-notification.json");
  assert.throws(() => runtimeEventEnvelopeSchema.parse(invalidEvent.params));
});
