import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  contextRecoveryViewSchema,
  runtimeEventEnvelopeV16Schema,
  runtimeEventEnvelopeV15Schema,
  projectRuntimeEventEnvelopeForVersion,
  projectThreadSnapshotForVersion,
  threadSnapshotV16Schema,
  threadSnapshotV15Schema,
} from "./index.ts";

const contextRecovery = {
  checkpointId: randomUUID(),
  required: true,
  unextracted: true,
  requiredItemCount: 24,
};
const timestamp = new Date(0).toISOString();

test("Protocol 1.6 recovery events downgrade without breaking durable cursor continuity", () => {
  const eventId = randomUUID();
  const source = runtimeEventEnvelopeV16Schema.parse({
    protocolVersion: "1.6",
    runtimeInstanceId: randomUUID(),
    sequence: 7,
    timestamp,
    threadId: randomUUID(),
    durability: "durable",
    eventId,
    cursor: `rte1:${randomUUID()}:7:${eventId}`,
    event: { type: "context.recovery.changed", contextRecovery },
  });
  assert.equal(runtimeEventEnvelopeV15Schema.safeParse(source).success, false);
  for (const version of ["1.6", "1.5", "1.4", "1.3", "1.2", "1.1", "1.0"] as const) {
    const event = projectRuntimeEventEnvelopeForVersion(version, source);
    assert.equal(
      event.event.type,
      version === "1.6" ? "context.recovery.changed" : "capabilities.changed",
    );
    if ("cursor" in event && "cursor" in source) assert.equal(event.cursor, source.cursor);
  }
  assert.equal(
    contextRecoveryViewSchema.safeParse({ ...contextRecovery, memo: "untrusted model notes" })
      .success,
    false,
  );
});

test("full and recovery-only snapshots retain the gate in 1.6 and strip it for old clients", () => {
  const base = {
    thread: { id: randomUUID(), createdAt: timestamp, updatedAt: timestamp, messageCount: 0 },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    pendingInteractions: [],
    transcriptCompleteness: "complete",
    eventCursor: null,
    contextRecovery,
  };
  for (const source of [base, { ...base, recoveryProjection: true }]) {
    assert.deepEqual(threadSnapshotV16Schema.parse(source).contextRecovery, contextRecovery);
    assert.equal(threadSnapshotV15Schema.safeParse(source).success, false);
    for (const version of ["1.5", "1.4", "1.3", "1.2", "1.1", "1.0"] as const) {
      assert.equal("contextRecovery" in projectThreadSnapshotForVersion(version, source), false);
    }
  }
});
