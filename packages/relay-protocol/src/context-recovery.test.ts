import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  projectRelayThreadSnapshotV13,
  projectRelayThreadSnapshotV12,
  projectRuntimeEventEnvelopeForRelayV13,
  projectRuntimeEventEnvelopeForRelayV12,
  projectRelayMessageV13ToV12,
  relayMessageSchemaV13,
} from "./index.ts";

test("Wire 1.3 preserves recovery state and bounded legacy downgrade keeps the same sequence", () => {
  const contextRecovery = {
    checkpointId: randomUUID(),
    required: true,
    unextracted: false,
    requiredItemCount: 3,
  };
  const timestamp = new Date(0).toISOString();
  const snapshot = {
    thread: { id: randomUUID(), createdAt: timestamp, updatedAt: timestamp, messageCount: 0 },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
    eventCursor: null,
    contextRecovery,
  };
  assert.deepEqual(projectRelayThreadSnapshotV13(snapshot).contextRecovery, contextRecovery);
  assert.equal("contextRecovery" in projectRelayThreadSnapshotV12(snapshot), false);
  const eventId = randomUUID();
  const source = {
    protocolVersion: "1.6",
    runtimeInstanceId: randomUUID(),
    sequence: 3,
    timestamp,
    threadId: snapshot.thread.id,
    durability: "durable",
    eventId,
    cursor: `rte1:${randomUUID()}:3:${eventId}`,
    event: { type: "context.recovery.changed", contextRecovery },
  };
  const projected = projectRuntimeEventEnvelopeForRelayV13(source)!;
  assert.deepEqual(projected.event, source.event);
  assert.equal(projectRuntimeEventEnvelopeForRelayV12(source)?.event.type, "capabilities.changed");
  const frame = relayMessageSchemaV13.parse({
    type: "runtime.event",
    workspaceId: randomUUID(),
    relaySequence: 9,
    event: projected,
  });
  const legacy = projectRelayMessageV13ToV12(frame);
  assert.ok(legacy.type === "runtime.event");
  assert.equal(legacy.relaySequence, 9);
  assert.equal(legacy.event.event.type, "capabilities.changed");
});
