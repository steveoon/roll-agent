import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  RUNTIME_ERROR_CODES_V13,
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES,
  parseRuntimeMethodParamsForVersion,
  projectClientCapabilitiesSetResult,
  runtimeDurableEventEnvelopeV13Schema,
  runtimeEphemeralEventEnvelopeV13Schema,
  runtimeEventCursorSchema,
  runtimeEventIdSchema,
  runtimeInstanceIdSchema,
  threadIdSchema,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type RuntimeEventCursor,
  type RuntimeEventId,
  type ThreadId,
} from "@roll-agent/protocol";
import {
  RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS,
  RollNodeClient,
  RollRuntimeShutdownTimeoutError,
  type RuntimeClientTransport,
  type RuntimeDurableEventEnvelope,
  type RuntimeEphemeralEventEnvelope,
  type RuntimeEventRecoverySnapshotReason,
} from "./index.ts";

const IDS = {
  runtime: runtimeInstanceIdSchema.parse("00000000-0000-4000-8000-000000000401"),
  otherRuntime: runtimeInstanceIdSchema.parse("00000000-0000-4000-8000-000000000402"),
  thread: threadIdSchema.parse("00000000-0000-4000-8000-000000000403"),
  otherThread: threadIdSchema.parse("00000000-0000-4000-8000-000000000404"),
  turn: "00000000-0000-4000-8000-000000000405",
  stream: "00000000-0000-4000-8000-000000000406",
  log: "00000000-0000-4000-8000-000000000407",
  events: [
    "00000000-0000-4000-8000-000000000410",
    "00000000-0000-4000-8000-000000000411",
    "00000000-0000-4000-8000-000000000412",
    "00000000-0000-4000-8000-000000000413",
    "00000000-0000-4000-8000-000000000414",
    "00000000-0000-4000-8000-000000000415",
  ].map((value) => runtimeEventIdSchema.parse(value)),
} as const;

class MemoryTransport implements RuntimeClientTransport {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  close(): void {
    for (const listener of this.exitListeners) {
      listener(0, null);
    }
  }
}

function writeJson(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function writeJsonChunk(stream: PassThrough, values: readonly unknown[]): void {
  stream.write(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function eventIdForSequence(sequence: number): RuntimeEventId {
  const eventId = IDS.events[sequence];
  if (eventId === undefined) {
    throw new Error(`Missing test Runtime Event ID for sequence ${String(sequence)}`);
  }
  return eventId;
}

function cursor(
  sequence: number,
  eventId: RuntimeEventId = eventIdForSequence(sequence),
): RuntimeEventCursor {
  return runtimeEventCursorSchema.parse(`rte1:${IDS.log}:${String(sequence)}:${eventId}`);
}

function durableEvent(
  sequence: number,
  options: { readonly threadId?: ThreadId; readonly eventId?: RuntimeEventId } = {},
): RuntimeDurableEventEnvelope {
  const eventId = options.eventId ?? eventIdForSequence(sequence);
  return runtimeDurableEventEnvelopeV13Schema.parse({
    protocolVersion: "1.3",
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-08-04T12:00:00.000Z",
    threadId: options.threadId ?? IDS.thread,
    turnId: IDS.turn,
    durability: "durable",
    eventId,
    cursor: cursor(sequence, eventId),
    event: { type: "turn.started" },
  });
}

function withProcessSequence(
  event: RuntimeDurableEventEnvelope,
  sequence: number,
): RuntimeDurableEventEnvelope {
  return runtimeDurableEventEnvelopeV13Schema.parse({ ...event, sequence });
}

function ephemeralEvent(sequence: number): RuntimeEphemeralEventEnvelope {
  return runtimeEphemeralEventEnvelopeV13Schema.parse({
    protocolVersion: "1.3",
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-08-04T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    durability: "ephemeral",
    event: { type: "message.delta", streamId: IDS.stream, delta: `delta-${String(sequence)}` },
  });
}

function snapshot(eventCursor: RuntimeEventCursor | null, protocolVersion: "1.4" | "1.3" | "1.2") {
  return {
    thread: {
      id: IDS.thread,
      title: "Recovery thread",
      model: "mock-model",
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:00.000Z",
      messageCount: 0,
    },
    messages: { items: [], nextBeforeSequence: null },
    operations: { items: [], nextBeforeSequence: null },
    pendingApprovals: [],
    transcriptCompleteness: "complete",
    pendingInteractions: [],
    ...(protocolVersion !== "1.2" ? { eventCursor, recoveryProjection: true as const } : {}),
  } as const;
}

type ResumeHandler = (request: JsonRpcRequest, runtime: RecoveryRuntime) => void;

class RecoveryRuntime {
  readonly transport: MemoryTransport;
  readonly messages: JsonRpcMessage[] = [];
  readonly resumeRequests: JsonRpcRequest[] = [];
  snapshotRequests = 0;
  readonly snapshotRequestParams: unknown[] = [];
  snapshotValue: unknown;
  onResume: ResumeHandler | undefined;
  private readonly protocolVersion: "1.4" | "1.3" | "1.2";

  constructor(
    protocolVersion: "1.4" | "1.3" | "1.2" = "1.3",
    transport: MemoryTransport = new MemoryTransport(),
  ) {
    this.protocolVersion = protocolVersion;
    this.transport = transport;
    this.snapshotValue = snapshot(null, protocolVersion);
    const reader = createInterface({ input: this.transport.stdin });
    reader.on("line", (line) => this.handle(JSON.parse(line) as JsonRpcMessage));
  }

  emitEvent(event: RuntimeDurableEventEnvelope | RuntimeEphemeralEventEnvelope): void {
    writeJson(this.transport.stdout, {
      jsonrpc: "2.0",
      method: RUNTIME_EVENT_NOTIFICATION,
      params: event,
    });
  }

  respond(request: JsonRpcRequest, result: unknown): void {
    writeJson(this.transport.stdout, { jsonrpc: "2.0", id: request.id, result });
  }

  failCursor(request: JsonRpcRequest, rollCode: "EVENT_CURSOR_EXPIRED" | "EVENT_CURSOR_GAP"): void {
    writeJson(this.transport.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32_000,
        message: rollCode,
        data: { rollCode, retryable: false },
      },
    });
  }

  private handle(message: JsonRpcMessage): void {
    this.messages.push(message);
    if (!("method" in message) || !("id" in message)) {
      return;
    }
    switch (message.method) {
      case RUNTIME_METHODS.initialize:
        this.respond(message, {
          protocolVersion: this.protocolVersion,
          runtimeInstanceId: IDS.runtime,
          server: {
            name: "recovery-runtime",
            version: "1.0.0",
            runtimeVersion: "0.9.0",
          },
          features: ["thread-management", "snapshots", "process-local-sequence"],
          limits: {
            maxFrameBytes: 4 * 1_024 * 1_024,
            maxPageSize: 500,
            eventReplay: this.protocolVersion !== "1.2",
            idempotencyCacheEntries: 10_000,
            ...(this.protocolVersion === "1.4"
              ? {
                  maxAttachmentBytes: 16 * 1_024 * 1_024,
                  maxAttachmentChunkBytes: 2 * 1_024 * 1_024,
                  maxTurnAttachments: 8,
                  maxStagedAttachments: 16,
                }
              : {}),
          },
        });
        return;
      case RUNTIME_METHODS.clientCapabilitiesSet:
        this.respond(message, projectClientCapabilitiesSetResult(message.params));
        return;
      case RUNTIME_METHODS.threadSnapshot:
        this.snapshotRequests += 1;
        this.snapshotRequestParams.push(message.params);
        this.respond(message, this.snapshotValue);
        return;
      case RUNTIME_METHODS.runtimeEventsResume:
        this.resumeRequests.push(message);
        if (this.onResume === undefined) {
          const params = parseRuntimeMethodParamsForVersion("1.3", message.method, message.params);
          this.respond(message, { throughCursor: params.afterCursor, replayedCount: 0 });
        } else {
          this.onResume(message, this);
        }
    }
  }
}

async function flushMessages(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("recovery claims a Thread, orders replay with concurrent live events and de-duplicates", async () => {
  const runtime = new RecoveryRuntime();
  runtime.onResume = (request, current) => {
    const replayOne = durableEvent(1);
    current.emitEvent(durableEvent(3));
    current.emitEvent(replayOne);
    current.emitEvent(replayOne);
    current.emitEvent(ephemeralEvent(20));
    current.emitEvent(durableEvent(2));
    writeJsonChunk(current.transport.stdout, [
      {
        jsonrpc: "2.0",
        id: request.id,
        result: { throughCursor: cursor(2), replayedCount: 2 },
      },
      {
        jsonrpc: "2.0",
        method: RUNTIME_EVENT_NOTIFICATION,
        params: durableEvent(4),
      },
    ]);
  };
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const rawEvents: RuntimeDurableEventEnvelope[] = [];
  client.onEvent((event) => {
    if (event.protocolVersion === "1.3" && event.durability === "durable") {
      rawEvents.push(event);
    }
  });
  const manager = client.createEventRecovery();
  const delivered: number[] = [];
  const activeCallbacks: number[] = [];
  let active = 0;
  let maxActive = 0;
  const ephemeral: RuntimeEphemeralEventEnvelope[] = [];

  const result = await manager.resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: () => assert.fail("direct resume must not request a Snapshot"),
    onDurableEvent: async (event) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      activeCallbacks.push(active);
      await flushMessages();
      delivered.push(Number(event.cursor.split(":")[2]));
      active -= 1;
    },
    onEphemeralEvent: (event) => ephemeral.push(event),
  });

  assert.equal(result.mode, "resumed");
  assert.deepEqual(delivered, [1, 2, 3, 4]);
  assert.equal(maxActive, 1);
  assert.deepEqual(activeCallbacks, [1, 1, 1, 1]);
  assert.equal(rawEvents.length, 0);
  assert.equal(ephemeral.length, 0);
  assert.equal(result.checkpoint.cursor, cursor(4));

  runtime.emitEvent(durableEvent(5));
  runtime.emitEvent(ephemeralEvent(21));
  runtime.emitEvent(durableEvent(5));
  await flushMessages();
  await flushMessages();
  assert.deepEqual(delivered, [1, 2, 3, 4, 5]);
  assert.equal(ephemeral.length, 1);
  assert.equal(manager.getCheckpoint(IDS.thread)?.cursor, cursor(5));

  runtime.emitEvent(durableEvent(1, { threadId: IDS.otherThread }));
  await flushMessages();
  assert.equal(rawEvents.length, 1);
  await client.shutdown();
});

test("replay and live copies ignore process-local sequence changes", async () => {
  const runtime = new RecoveryRuntime();
  runtime.onResume = (request, current) => {
    const event = durableEvent(1);
    current.emitEvent(withProcessSequence(event, 101));
    writeJsonChunk(current.transport.stdout, [
      {
        jsonrpc: "2.0",
        id: request.id,
        result: { throughCursor: event.cursor, replayedCount: 1 },
      },
      {
        jsonrpc: "2.0",
        method: RUNTIME_EVENT_NOTIFICATION,
        params: withProcessSequence(event, 202),
      },
    ]);
  };
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const reasons: RuntimeEventRecoverySnapshotReason[] = [];
  const delivered: number[] = [];

  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: (_snapshot, context) => {
      reasons.push(context.reason);
    },
    onDurableEvent: (event) => {
      delivered.push(event.sequence);
    },
  });

  assert.equal(result.mode, "resumed");
  assert.deepEqual(delivered, [101]);
  assert.deepEqual(reasons, []);
  assert.equal(runtime.snapshotRequests, 0);
  assert.equal(runtime.resumeRequests.length, 1);
  assert.equal(result.checkpoint.cursor, cursor(1));
  await client.shutdown();
});

test("a reused durable identity with conflicting payload falls back to Snapshot", async () => {
  const runtime = new RecoveryRuntime();
  runtime.snapshotValue = snapshot(cursor(1), "1.3");
  runtime.onResume = (request, current) => {
    if (current.resumeRequests.length === 1) {
      const event = durableEvent(1);
      current.emitEvent(withProcessSequence(event, 101));
      current.emitEvent(
        runtimeDurableEventEnvelopeV13Schema.parse({
          ...event,
          sequence: 202,
          event: { type: "turn.completed" },
        }),
      );
      current.respond(request, { throughCursor: event.cursor, replayedCount: 1 });
      return;
    }
    current.respond(request, { throughCursor: cursor(1), replayedCount: 0 });
  };
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const reasons: RuntimeEventRecoverySnapshotReason[] = [];
  const delivered: RuntimeDurableEventEnvelope[] = [];

  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: (_snapshot, context) => {
      reasons.push(context.reason);
    },
    onDurableEvent: (event) => {
      delivered.push(event);
    },
  });

  assert.equal(result.mode, "snapshot-resumed");
  assert.deepEqual(delivered, []);
  assert.deepEqual(reasons, [RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict]);
  assert.equal(runtime.snapshotRequests, 1);
  assert.deepEqual(runtime.snapshotRequestParams, [
    { threadId: IDS.thread, limit: 1, recovery: true },
  ]);
  assert.equal(runtime.resumeRequests.length, 2);
  assert.equal(result.checkpoint.cursor, cursor(1));
  await client.shutdown();
});

test("default frame and replay budgets accept a near-limit durable event", async () => {
  const runtime = new RecoveryRuntime();
  const event = runtimeDurableEventEnvelopeV13Schema.parse({
    ...durableEvent(1),
    event: {
      type: "message.completed",
      streamId: IDS.stream,
      text: "x".repeat(RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES - 4_096),
    },
  });
  runtime.onResume = (request, current) => {
    current.emitEvent(event);
    current.respond(request, { throughCursor: event.cursor, replayedCount: 1 });
  };
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const delivered: number[] = [];
  const manager = client.createEventRecovery();
  const result = await manager.resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: () => assert.fail("near-limit replay must not fall back to Snapshot"),
    onDurableEvent: (received) => {
      assert.equal(received.event.type, "message.completed");
      if (received.event.type === "message.completed") {
        delivered.push(received.event.text.length);
      }
    },
  });

  assert.equal(result.mode, "resumed");
  assert.deepEqual(delivered, [RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES - 4_096]);
  const internal = manager as unknown as {
    readonly states: Map<
      ThreadId,
      { readonly seenByEventId: Map<RuntimeEventId, { readonly fingerprint: string }> }
    >;
  };
  const fingerprints = [...(internal.states.get(IDS.thread)?.seenByEventId.values() ?? [])].map(
    (seen) => seen.fingerprint,
  );
  assert.equal(fingerprints.length, 1);
  assert.match(fingerprints[0] ?? "", /^[0-9a-f]{64}$/u);
  await client.shutdown();
});

test("default recovery budget accepts the full 10,000-event retained window", async () => {
  const runtime = new RecoveryRuntime();
  const replayCount = 10_000;
  runtime.onResume = (request, current) => {
    for (let sequence = 1; sequence <= replayCount; sequence += 1) {
      const suffix = sequence.toString(16).padStart(12, "0");
      const eventId = runtimeEventIdSchema.parse(`00000000-0000-4000-8000-${suffix}`);
      current.emitEvent(
        runtimeDurableEventEnvelopeV13Schema.parse({
          protocolVersion: "1.3",
          runtimeInstanceId: IDS.runtime,
          sequence,
          timestamp: "2026-08-04T12:00:00.000Z",
          threadId: IDS.thread,
          turnId: IDS.turn,
          durability: "durable",
          eventId,
          cursor: `rte1:${IDS.log}:${String(sequence)}:${eventId}`,
          event: { type: "turn.started" },
        }),
      );
    }
    const finalEventId = runtimeEventIdSchema.parse(
      `00000000-0000-4000-8000-${replayCount.toString(16).padStart(12, "0")}`,
    );
    current.respond(request, {
      throughCursor: `rte1:${IDS.log}:${String(replayCount)}:${finalEventId}`,
      replayedCount: replayCount,
    });
  };
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  let delivered = 0;
  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: () => assert.fail("full retained window must fit the default replay budget"),
    onDurableEvent: () => {
      delivered += 1;
    },
  });

  assert.equal(result.mode, "resumed");
  assert.equal(delivered, replayCount);
  await client.shutdown();
});

test("missing checkpoint applies a Snapshot and resumes from its nullable eventCursor", async () => {
  const runtime = new RecoveryRuntime();
  runtime.snapshotValue = snapshot(null, "1.3");
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const reasons: RuntimeEventRecoverySnapshotReason[] = [];
  const projections: boolean[] = [];
  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    applySnapshot: (_snapshot, context) => {
      reasons.push(context.reason);
      projections.push(context.recoveryProjection);
    },
    onDurableEvent: () => {},
  });

  assert.equal(result.mode, "snapshot-resumed");
  assert.deepEqual(reasons, [RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.initial]);
  assert.deepEqual(projections, [true]);
  assert.equal(runtime.snapshotRequests, 1);
  assert.equal(runtime.resumeRequests.length, 1);
  assert.deepEqual(runtime.resumeRequests[0]?.params, {
    threadId: IDS.thread,
    afterCursor: null,
  });
  assert.equal(result.checkpoint.cursor, null);
  await client.shutdown();
});

for (const rollCode of [
  RUNTIME_ERROR_CODES_V13.eventCursorExpired,
  RUNTIME_ERROR_CODES_V13.eventCursorGap,
] as const) {
  test(`${rollCode} converges through Snapshot and a second resume barrier`, async () => {
    const runtime = new RecoveryRuntime();
    runtime.snapshotValue = snapshot(cursor(2), "1.3");
    runtime.onResume = (request, current) => {
      if (current.resumeRequests.length === 1) {
        current.failCursor(request, rollCode);
        return;
      }
      current.respond(request, { throughCursor: cursor(2), replayedCount: 0 });
    };
    const client = await RollNodeClient.connect({ transport: runtime.transport });
    const reasons: RuntimeEventRecoverySnapshotReason[] = [];
    const result = await client.createEventRecovery().resumeThread({
      threadId: IDS.thread,
      checkpoint: {
        threadId: IDS.thread,
        runtimeInstanceId: IDS.runtime,
        cursor: cursor(0),
      },
      applySnapshot: (_snapshot, context) => {
        reasons.push(context.reason);
      },
      onDurableEvent: () => {},
    });

    assert.equal(result.mode, "snapshot-resumed");
    assert.deepEqual(reasons, [
      rollCode === RUNTIME_ERROR_CODES_V13.eventCursorExpired
        ? RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorExpired
        : RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorGap,
    ]);
    assert.equal(runtime.snapshotRequests, 1);
    assert.equal(runtime.resumeRequests.length, 2);
    assert.deepEqual(runtime.resumeRequests[1]?.params, {
      threadId: IDS.thread,
      afterCursor: cursor(2),
    });
    await client.shutdown();
  });
}

test("Runtime instance change skips the stale cursor and starts with Snapshot", async () => {
  const runtime = new RecoveryRuntime();
  runtime.snapshotValue = snapshot(cursor(2), "1.3");
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const reasons: RuntimeEventRecoverySnapshotReason[] = [];
  const projections: boolean[] = [];
  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.otherRuntime,
      cursor: cursor(0),
    },
    applySnapshot: (_snapshot, context) => {
      reasons.push(context.reason);
      projections.push(context.recoveryProjection);
    },
    onDurableEvent: () => {},
  });

  assert.equal(result.mode, "snapshot-resumed");
  assert.deepEqual(reasons, [RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.runtimeRestarted]);
  assert.deepEqual(projections, [true]);
  assert.equal(runtime.resumeRequests.length, 1);
  const resumeRequest = runtime.resumeRequests[0];
  assert.ok(resumeRequest);
  assert.equal(
    parseRuntimeMethodParamsForVersion(
      "1.3",
      RUNTIME_METHODS.runtimeEventsResume,
      resumeRequest.params,
    ).afterCursor,
    cursor(2),
  );
  await client.shutdown();
});

test("bounded buffer overflow falls back to Snapshot before returning live", async () => {
  const runtime = new RecoveryRuntime();
  runtime.snapshotValue = snapshot(cursor(2), "1.3");
  runtime.onResume = (request, current) => {
    if (current.resumeRequests.length === 1) {
      current.emitEvent(durableEvent(1));
      current.emitEvent(durableEvent(2));
      current.respond(request, { throughCursor: cursor(2), replayedCount: 2 });
      return;
    }
    current.respond(request, { throughCursor: cursor(2), replayedCount: 0 });
  };
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const reasons: RuntimeEventRecoverySnapshotReason[] = [];
  const result = await client.createEventRecovery({ maxBufferedEvents: 1 }).resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: (_snapshot, context) => {
      reasons.push(context.reason);
    },
    onDurableEvent: () => {},
  });

  assert.equal(result.mode, "snapshot-resumed");
  assert.deepEqual(reasons, [RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.bufferOverflow]);
  assert.equal(runtime.resumeRequests.length, 2);
  await client.shutdown();
});

test("Protocol 1.2 is explicit snapshot-only compatibility and sends no resume RPC", async () => {
  const runtime = new RecoveryRuntime("1.2");
  runtime.snapshotValue = snapshot(null, "1.2");
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  const reasons: RuntimeEventRecoverySnapshotReason[] = [];
  const projections: boolean[] = [];
  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    applySnapshot: (_snapshot, context) => {
      reasons.push(context.reason);
      projections.push(context.recoveryProjection);
    },
    onDurableEvent: () => assert.fail("Protocol 1.2 has no durable replay"),
  });

  assert.equal(result.mode, "snapshot-only");
  assert.equal(result.protocolVersion, "1.2");
  assert.deepEqual(reasons, [RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.protocolUnsupported]);
  assert.deepEqual(projections, [false]);
  assert.deepEqual(runtime.snapshotRequestParams, [{ threadId: IDS.thread, limit: 1 }]);
  assert.equal(runtime.snapshotRequests, 1);
  assert.equal(runtime.resumeRequests.length, 0);
  assert.equal(
    runtime.messages.some(
      (message) => "method" in message && message.method === RUNTIME_METHODS.runtimeEventsResume,
    ),
    false,
  );
  await client.shutdown();
});

test("shutdown timeout fails a claimed recovery Thread exactly once", async () => {
  class UnresponsiveTransport extends MemoryTransport {
    override close(): void {}
  }

  const transport = new UnresponsiveTransport();
  const runtime = new RecoveryRuntime("1.3", transport);
  const client = await RollNodeClient.connect({ transport });
  const recoveryErrors: Error[] = [];
  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: () => assert.fail("direct resume must not request a Snapshot"),
    onDurableEvent: () => {},
    onError: (error) => recoveryErrors.push(error),
  });
  assert.equal(result.mode, "resumed");
  assert.equal(runtime.resumeRequests.length, 1);

  await assert.rejects(
    client.shutdown({
      gracefulTimeoutMs: 10,
      terminateTimeoutMs: 10,
      forceKillTimeoutMs: 10,
    }),
    RollRuntimeShutdownTimeoutError,
  );
  assert.equal(recoveryErrors.length, 1);
  assert.ok(recoveryErrors[0] instanceof RollRuntimeShutdownTimeoutError);
});

test("transport exit is terminal before a recovery onError re-enters shutdown", async () => {
  const runtime = new RecoveryRuntime();
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  let exitNotifications = 0;
  let recoveryErrors = 0;
  let reentrantShutdown: Promise<unknown> | undefined;
  client.onExit(() => {
    exitNotifications += 1;
  });
  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    checkpoint: {
      threadId: IDS.thread,
      runtimeInstanceId: IDS.runtime,
      cursor: cursor(0),
    },
    applySnapshot: () => assert.fail("direct resume must not request a Snapshot"),
    onDurableEvent: () => {},
    onError: () => {
      recoveryErrors += 1;
      reentrantShutdown = client.shutdown();
    },
  });
  assert.equal(result.mode, "resumed");

  runtime.transport.close();
  assert.ok(reentrantShutdown);
  await reentrantShutdown;
  assert.equal(recoveryErrors, 1);
  assert.equal(exitNotifications, 1);

  runtime.transport.close();
  assert.equal(recoveryErrors, 1);
  assert.equal(exitNotifications, 1);
});

test("recovery resumes a 1.4 session with durable replay and an honest projection context", async (t) => {
  const runtime = new RecoveryRuntime("1.4");
  const client = await RollNodeClient.connect({ transport: runtime.transport });
  t.after(() => client.shutdown());
  const contexts: unknown[] = [];
  const result = await client.createEventRecovery().resumeThread({
    threadId: IDS.thread,
    applySnapshot: (_snapshot, context) => {
      contexts.push(context);
    },
    onDurableEvent: () => {},
  });
  assert.equal(result.mode, "snapshot-resumed");
  assert.equal(result.protocolVersion, "1.4");
  assert.ok(result.checkpoint !== null);
  assert.deepEqual(contexts, [
    { reason: "initial", protocolVersion: "1.4", recoveryProjection: true },
  ]);
  assert.equal(runtime.resumeRequests.length, 1);
});
