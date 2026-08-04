import assert from "node:assert/strict";
import test from "node:test";
import { approvalIdSchema, threadIdSchema, turnIdSchema } from "@roll-agent/protocol";
import {
  RELAY_INTERACTION_METHODS_V11,
  deviceIdSchema,
  relayInteractionIdSchema,
  relayInteractionCandidateParamsSchemaV11,
  relayRequestIdSchema,
  workspaceIdSchema,
  type RelayMessageV11,
  type RelayRuntimeRequestV11,
} from "@roll-agent/relay-protocol";
import type { RemoteInteractionCandidateContext } from "./interaction-broker.ts";
import {
  CompanionRelayBridgeV11,
  type CompanionWorkspaceV11Port,
  type RelayPayloadCipherV11,
} from "./relay-bridge-v11.ts";
import {
  CompanionRelayFrameBuffer,
  type CompanionRelayFrameEntryV11,
} from "./relay-frame-buffer.ts";
import { InMemoryRelayTransportV11 } from "./testing.ts";
import {
  runRelayProtocolConformanceForVersion,
  runtimeRelayProtocolConformanceAdapterV11,
} from "@roll-agent/relay-protocol/conformance";

const IDS = {
  device: deviceIdSchema.parse("00000000-0000-4000-8000-000000000201"),
  workspace: workspaceIdSchema.parse("00000000-0000-4000-8000-000000000202"),
  thread: threadIdSchema.parse("00000000-0000-4000-8000-000000000203"),
  turn: turnIdSchema.parse("00000000-0000-4000-8000-000000000204"),
  interaction: relayInteractionIdSchema.parse("00000000-0000-4000-8000-000000000205"),
  approval: approvalIdSchema.parse("00000000-0000-4000-8000-000000000206"),
  request: relayRequestIdSchema.parse("00000000-0000-4000-8000-000000000207"),
} as const;

class WorkspacePort implements CompanionWorkspaceV11Port {
  readonly frames = new CompanionRelayFrameBuffer();
  calls = 0;
  closeCalls = 0;
  private readonly listeners = new Set<(entry: CompanionRelayFrameEntryV11) => void>();

  onBufferedRelayFrameV11(listener: (entry: CompanionRelayFrameEntryV11) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replayRelayFramesV11(afterRelaySequence = -1) {
    return this.frames.replay(afterRelaySequence);
  }

  acknowledgeRelayFramesV11(throughRelaySequence: number): void {
    this.frames.acknowledge(throughRelaySequence);
  }

  async handleRemoteRequestV11(
    _request: RelayRuntimeRequestV11,
    _context: RemoteInteractionCandidateContext,
  ): Promise<unknown> {
    this.calls += 1;
    return { accepted: true };
  }

  closeRemoteInteractions(): void {
    this.closeCalls += 1;
  }

  appendInteraction(decision = "approve"): CompanionRelayFrameEntryV11 {
    const entry = this.frames.appendInteraction({
      type: "interaction.request",
      interactionId: IDS.interaction,
      threadId: IDS.thread,
      turnId: IDS.turn,
      expiresAt: "2099-08-04T12:00:00.000Z",
      sensitivity: "normal",
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      projection: {
        approvalId: IDS.approval,
        agentName: "deploy-agent",
        toolName: `deploy-${decision}`,
      },
    });
    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }
}

function candidate(decision: "approve" | "reject" = "approve") {
  return relayInteractionCandidateParamsSchemaV11.parse({
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
    candidate: { decision },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function responses(messages: readonly RelayMessageV11[]) {
  return messages.filter((message) => message.type === "runtime.response");
}

test("Companion Wire 1.1 consumes the shared Relay conformance suite", () => {
  assert.deepEqual(
    runRelayProtocolConformanceForVersion("1.1", runtimeRelayProtocolConformanceAdapterV11),
    { protocolVersion: "1.1", passed: true, failures: [] },
  );
});

test("Wire 1.1 mutation cache deduplicates candidates and rejects conflicts", async () => {
  const workspace = new WorkspacePort();
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const transport = new InMemoryRelayTransportV11();
  bridge.connect(transport, { responderContext: null, responderPolicy: () => true });

  transport.injectDuplicateCandidate({
    requestId: IDS.request,
    workspaceId: IDS.workspace,
    params: candidate(),
  });
  await flush();
  assert.equal(workspace.calls, 1);
  assert.equal(responses(transport.outbound).length, 2);
  assert.deepEqual(responses(transport.outbound)[0]?.result, { accepted: true });

  transport.injectCandidate({
    requestId: IDS.request,
    workspaceId: IDS.workspace,
    params: candidate("reject"),
  });
  await flush();
  assert.equal(workspace.calls, 1);
  assert.equal(responses(transport.outbound).at(-1)?.error?.code, "RELAY_REQUEST_ID_CONFLICT");
  bridge.close();
});

test("Wire 1.1 replays the same frame sequence after a send generation fails", async () => {
  const workspace = new WorkspacePort();
  const original = workspace.appendInteraction();
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const first = new InMemoryRelayTransportV11();
  bridge.connect(first, { responderContext: "first", responderPolicy: () => true });
  await flush();
  first.disconnect();

  const second = new InMemoryRelayTransportV11();
  bridge.connect(second, { responderContext: "second", responderPolicy: () => true });
  await flush();
  const replay = second.outbound.find(
    (message): message is Extract<RelayMessageV11, { readonly type: "interaction.request" }> =>
      message.type === "interaction.request",
  );
  assert.equal(replay?.relaySequence, original.relaySequence);
  bridge.close();
  assert.equal(workspace.closeCalls, 1);
});

test("Wire 1.1 ACK advances only through the prefix advertised on that generation", async () => {
  const workspace = new WorkspacePort();
  workspace.appendInteraction("approve");
  workspace.appendInteraction("reject");
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
  });
  const first = new InMemoryRelayTransportV11();
  bridge.connect(first, { responderContext: null, responderPolicy: () => true });
  await flush();
  first.injectAck(IDS.workspace, 0);
  await flush();
  assert.equal(workspace.frames.size, 1);

  first.injectAck(IDS.workspace, 99);
  await flush();
  assert.equal(workspace.frames.size, 1, "ACK beyond the advertised prefix must be ignored");
  first.disconnect();

  const second = new InMemoryRelayTransportV11();
  bridge.connect(second, { responderContext: null, responderPolicy: () => true });
  await flush();
  const replayed = second.outbound.filter(
    (message): message is Extract<RelayMessageV11, { readonly type: "interaction.request" }> =>
      message.type === "interaction.request",
  );
  assert.deepEqual(
    replayed.map((message) => message.relaySequence),
    [1],
  );
  bridge.close();
});

test("Wire 1.1 encrypts Interaction frames as interaction payloads", async () => {
  const workspace = new WorkspacePort();
  workspace.appendInteraction();
  const encryptedValues: unknown[] = [];
  const cipher: RelayPayloadCipherV11 = {
    algorithm: "fixture-aead",
    async encrypt(value) {
      encryptedValues.push(value);
      return { nonce: "fixture-nonce", ciphertext: "fixture-ciphertext" };
    },
    async decrypt() {
      throw new Error("decrypt is not used by this fixture");
    },
  };
  const bridge = new CompanionRelayBridgeV11({
    deviceId: IDS.device,
    pairingToken: "pairing-token-long-enough",
    workspaces: new Map([[IDS.workspace, workspace]]),
    ciphers: new Map([[IDS.workspace, cipher]]),
  });
  const transport = new InMemoryRelayTransportV11();
  bridge.connect(transport, { responderContext: null, responderPolicy: () => true });
  await flush();

  const encrypted = transport.outbound.find(
    (message): message is Extract<RelayMessageV11, { readonly type: "runtime.encrypted" }> =>
      message.type === "runtime.encrypted" && message.payloadKind === "interaction",
  );
  assert.ok(encrypted);
  assert.equal(encrypted.relaySequence, 0);
  const encryptedValue = encryptedValues[0];
  assert.ok(typeof encryptedValue === "object" && encryptedValue !== null);
  assert.equal(Reflect.get(encryptedValue, "type"), "interaction.request");
  bridge.close();
});
