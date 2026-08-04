import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELAY_INTERACTION_METHODS_V11,
  deviceIdSchema,
  relayInteractionCandidateParamsSchemaV11,
  relayMessageSchemaV11,
  relayRequestIdSchema,
  workspaceIdSchema,
} from "@roll-agent/relay-protocol";
import { InMemoryRelayTransportV11 } from "./testing.ts";

const IDS = {
  device: "00000000-0000-4000-8000-000000000711",
  workspace: "00000000-0000-4000-8000-000000000712",
  request: "00000000-0000-4000-8000-000000000713",
  duplicateRequest: "00000000-0000-4000-8000-000000000714",
  lateRequest: "00000000-0000-4000-8000-000000000715",
  interaction: "00000000-0000-4000-8000-000000000716",
  thread: "00000000-0000-4000-8000-000000000717",
  turn: "00000000-0000-4000-8000-000000000718",
} as const;

const workspaceId = workspaceIdSchema.parse(IDS.workspace);

function candidateInput(requestId: string) {
  return {
    requestId: relayRequestIdSchema.parse(requestId),
    workspaceId,
    params: relayInteractionCandidateParamsSchemaV11.parse({
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      candidate: { decision: "approve" },
    }),
  };
}

test("in-memory Wire 1.1 transport captures outbound and injects candidate duplicates", () => {
  const transport = new InMemoryRelayTransportV11();
  const received: unknown[] = [];
  transport.onMessage((message) => {
    received.push(message);
  });

  const outbound = relayMessageSchemaV11.parse({
    type: "device.connect",
    protocolVersion: "1.1",
    deviceId: deviceIdSchema.parse(IDS.device),
    pairingToken: "test-only-pairing-token",
  });
  transport.send(outbound);
  assert.deepEqual(transport.outbound, [outbound]);

  const candidate = transport.injectCandidate(candidateInput(IDS.request));
  assert.equal(candidate.method, "interaction.candidate");
  transport.injectDuplicateCandidate(candidateInput(IDS.duplicateRequest));
  assert.equal(received.length, 3);
  assert.deepEqual(received[1], received[2]);
});

test("in-memory Wire 1.1 transport can simulate stale-generation late candidates", () => {
  const transport = new InMemoryRelayTransportV11();
  const received: unknown[] = [];
  let closes = 0;
  const releaseMessage = transport.onMessage((message) => {
    received.push(message);
  });
  transport.onClose(() => {
    closes += 1;
    releaseMessage();
  });

  assert.throws(() => transport.injectLateCandidate(candidateInput(IDS.lateRequest)));
  transport.disconnect();
  transport.disconnect();
  assert.equal(transport.isDisconnected, true);
  assert.equal(closes, 1);

  const late = transport.injectLateCandidate(candidateInput(IDS.lateRequest));
  assert.equal(received.length, 1);
  assert.equal(received[0], late);
  assert.throws(() => transport.injectCandidate(candidateInput(IDS.request)));
  assert.throws(() => transport.send(relayMessageSchemaV11.parse(late)));
});
