import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES,
  runtimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
} from "@roll-agent/protocol";
import {
  RELAY_INTERACTION_METHODS_V11,
  relayInteractionRequestSchemaV11,
  relayMessageSchemaV11,
  workspaceIdSchema,
} from "@roll-agent/relay-protocol";
import { CompanionRelayFrameBuffer, materializeRelayFrameV11 } from "./relay-frame-buffer.ts";

const IDS = {
  runtime: "00000000-0000-4000-8000-000000000701",
  workspace: "00000000-0000-4000-8000-000000000702",
  thread: "00000000-0000-4000-8000-000000000703",
  turn: "00000000-0000-4000-8000-000000000704",
  interaction: "00000000-0000-4000-8000-000000000705",
  approval: "00000000-0000-4000-8000-000000000706",
  runtimeEvent: "00000000-0000-4000-8000-000000000707",
  eventLog: "00000000-0000-4000-8000-000000000708",
} as const;

const workspaceId = workspaceIdSchema.parse(IDS.workspace);

function envelope(sequence: number, event: RuntimeEventEnvelope["event"]): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.2",
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-08-04T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    event,
  });
}

function durableEnvelope(sequence: number, event: unknown): RuntimeEventEnvelope {
  return runtimeEventEnvelopeSchema.parse({
    protocolVersion: "1.3",
    runtimeInstanceId: IDS.runtime,
    sequence,
    timestamp: "2026-08-04T12:00:00.000Z",
    threadId: IDS.thread,
    turnId: IDS.turn,
    durability: "durable",
    eventId: IDS.runtimeEvent,
    cursor: `rte1:${IDS.eventLog}:${String(sequence)}:${IDS.runtimeEvent}`,
    event,
  });
}

function approvalRequestDraft() {
  const request = relayInteractionRequestSchemaV11.parse({
    type: "interaction.request",
    workspaceId,
    relaySequence: 0,
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-08-04T12:05:00.000Z",
    sensitivity: "normal",
    method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
    projection: {
      approvalId: IDS.approval,
      agentName: "workspace-agent",
      toolName: "deploy",
      explanation: "部署前需要确认。",
    },
  });
  assert.equal(request.method, RELAY_INTERACTION_METHODS_V11.approvalRequest);
  return {
    type: request.type,
    interactionId: request.interactionId,
    threadId: request.threadId,
    turnId: request.turnId,
    expiresAt: request.expiresAt,
    sensitivity: request.sensitivity,
    method: request.method,
    projection: request.projection,
  };
}

test("Wire 1.1 frame buffer shares one sequence across runtime and interaction frames", () => {
  const buffer = new CompanionRelayFrameBuffer();
  const started = buffer.appendRuntimeEvent(envelope(0, { type: "turn.started" }));
  const interaction = buffer.appendInteraction(approvalRequestDraft());
  const filtered = buffer.appendRuntimeEvent(
    envelope(1, {
      type: "tool.output",
      toolCallId: "tool-1",
      agentName: "workspace-agent",
      toolName: "deploy",
      stream: "stdout",
      delta: "must-not-cross-wire",
    }),
  );
  const completed = buffer.appendRuntimeEvent(envelope(2, { type: "turn.completed" }));

  assert.equal(started?.relaySequence, 0);
  assert.equal(interaction.relaySequence, 1);
  assert.equal(filtered, undefined);
  assert.equal(completed?.relaySequence, 2);
  assert.equal(buffer.highestRelaySequence, 2);
  assert.deepEqual(
    buffer.replay().frames.map((entry) => [entry.relaySequence, entry.type]),
    [
      [0, "runtime.event"],
      [1, "interaction.request"],
      [2, "runtime.event"],
    ],
  );
});

test("Wire 1.1 frame replay reports count/byte gaps and supports ACK", () => {
  const buffer = new CompanionRelayFrameBuffer({ maxEvents: 2, maxBytes: 1_000_000 });
  buffer.appendRuntimeEvent(envelope(0, { type: "turn.started" }));
  buffer.appendInteraction(approvalRequestDraft());
  buffer.appendRuntimeEvent(envelope(1, { type: "turn.completed" }));

  assert.deepEqual(buffer.replay(-1), {
    gap: { fromRelaySequence: 0, throughRelaySequence: 0 },
    frames: buffer.replay(0).frames,
  });
  assert.deepEqual(
    buffer.replay(0).frames.map((entry) => entry.relaySequence),
    [1, 2],
  );

  buffer.acknowledge(1);
  assert.equal(buffer.size, 1);
  assert.deepEqual(
    buffer.replay(1).frames.map((entry) => entry.relaySequence),
    [2],
  );
  buffer.acknowledge(99);
  assert.equal(buffer.size, 1);

  const byteLimited = new CompanionRelayFrameBuffer({ maxEvents: 10, maxBytes: 1 });
  byteLimited.appendRuntimeEvent(envelope(2, { type: "turn.completed" }));
  assert.equal(byteLimited.size, 0);
  assert.deepEqual(byteLimited.replay().gap, {
    fromRelaySequence: 0,
    throughRelaySequence: 0,
  });
});

test("Wire 1.1 frame buffer default retains one near-limit durable Runtime event", () => {
  const nearLimitText = "x".repeat(RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES - 256);
  const event = durableEnvelope(0, {
    type: "message.completed",
    streamId: IDS.turn,
    text: nearLimitText,
  });
  const buffer = new CompanionRelayFrameBuffer();
  const entry = buffer.appendRuntimeEvent(event);

  assert.ok(entry !== undefined);
  assert.ok(buffer.bytes > RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES);
  assert.equal(buffer.size, 1);
  assert.equal(buffer.replay().gap, undefined);
  assert.equal(buffer.replay().frames[0], entry);
});

test("materialization is schema-strict and safe projections do not leak tool data", () => {
  const buffer = new CompanionRelayFrameBuffer();
  const runtimeEntry = buffer.appendRuntimeEvent(
    envelope(0, {
      type: "tool.started",
      toolCallId: "tool-1",
      agentName: "workspace-agent",
      toolName: "deploy",
      input: { command: "secret command" },
    }),
  );
  assert.ok(runtimeEntry !== undefined);
  const runtimeFrame = materializeRelayFrameV11(workspaceId, runtimeEntry);
  assert.deepEqual(relayMessageSchemaV11.parse(runtimeFrame), runtimeFrame);
  assert.equal(JSON.stringify(runtimeFrame).includes("secret command"), false);
  assert.ok(runtimeFrame.type === "runtime.event");
  assert.equal("input" in runtimeFrame.event.event, false);

  const interactionEntry = buffer.appendInteraction(approvalRequestDraft());
  const interactionFrame = materializeRelayFrameV11(workspaceId, interactionEntry);
  assert.deepEqual(relayMessageSchemaV11.parse(interactionFrame), interactionFrame);
  assert.ok(interactionFrame.type === "interaction.request");
  assert.equal(interactionFrame.workspaceId, workspaceId);

  const unsafeDraft = {
    ...approvalRequestDraft(),
    rawToolInput: { command: "must-not-cross-wire" },
  };
  assert.throws(() => buffer.appendInteraction(unsafeDraft));
  const incorrectlyRoutedDraft = {
    ...approvalRequestDraft(),
    workspaceId,
    relaySequence: 99,
  };
  assert.throws(() => buffer.appendInteraction(incorrectlyRoutedDraft));
});

test("invalid frame buffer bounds and replay cursors fail closed", () => {
  assert.throws(() => new CompanionRelayFrameBuffer({ maxEvents: 0 }));
  assert.throws(() => new CompanionRelayFrameBuffer({ maxBytes: 0 }));
  const buffer = new CompanionRelayFrameBuffer();
  assert.throws(() => buffer.replay(-2));
  assert.throws(() => buffer.acknowledge(-2));
});
