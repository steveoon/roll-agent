import assert from "node:assert/strict";
import test from "node:test";
import { relayMessageSchemaV11 } from "./index.ts";
import {
  RELAY_BROWSER_HANDSHAKE_ERROR_CODE_VALUES,
  RELAY_BROWSER_HANDSHAKE_ERROR_CODES,
  RELAY_BROWSER_CONTROL_MESSAGE_TYPE_VALUES,
  RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION,
  RELAY_CLIENT_ERROR_CODE_VALUES,
  RELAY_CLIENT_ERROR_CODES,
  RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION,
  RELAY_CONTROL_DIRECTIONS,
  RELAY_CONTROL_MESSAGE_TYPES_BY_DIRECTION,
  RELAY_WSS_DIRECTIONS,
  isRelayBrowserWssMessageTypeAllowed,
  isRelayCompanionWssMessageTypeAllowed,
  isRelayControlMessageTypeAllowed,
  parseRelayBrowserFirstControlFrame,
  relayBrowserHandshakeErrorCodeSchema,
  relayBrowserControlMessageSchema,
  relayBrowserFirstControlFrameSchema,
  relayClientErrorCodeSchema,
  relaySessionDescriptorSchema,
} from "./control.ts";

const IDS = {
  session: "browser-session-301",
  workspace: "00000000-0000-4000-8000-000000000302",
} as const;

function sessionReady() {
  return {
    type: "session.ready",
    controlVersion: "1.0",
    relayProtocolVersion: "1.1",
    sessionId: IDS.session,
    workspaceId: IDS.workspace,
    workspaceStatus: "online",
  } as const;
}

test("Control 1.0 accepts the frozen Relay-to-Browser messages", () => {
  assert.deepEqual(relayBrowserControlMessageSchema.parse(sessionReady()), sessionReady());
  assert.deepEqual(
    relayBrowserControlMessageSchema.parse({
      type: "workspace.status",
      workspaceId: IDS.workspace,
      status: "offline",
    }),
    { type: "workspace.status", workspaceId: IDS.workspace, status: "offline" },
  );
  assert.deepEqual(
    relayBrowserControlMessageSchema.parse({
      type: "session.error",
      code: RELAY_CLIENT_ERROR_CODES.workspaceOffline,
      retryable: true,
    }),
    {
      type: "session.error",
      code: RELAY_CLIENT_ERROR_CODES.workspaceOffline,
      retryable: true,
    },
  );
});

test("Browser session descriptors require a strict wss URL and ISO expiry", () => {
  const descriptor = {
    connectUrl: "wss://relay.example.test/v1/browser?ticket=single-use",
    expiresAt: "2026-08-06T12:00:00.000Z",
  } as const;
  assert.deepEqual(relaySessionDescriptorSchema.parse(descriptor), descriptor);
  assert.throws(() =>
    relaySessionDescriptorSchema.parse({ ...descriptor, connectUrl: "ws://relay.example.test" }),
  );
  assert.throws(() =>
    relaySessionDescriptorSchema.parse({ ...descriptor, connectUrl: "https://relay.example.test" }),
  );
  assert.throws(() =>
    relaySessionDescriptorSchema.parse({ ...descriptor, connectUrl: "wss://not a valid url" }),
  );
  for (const connectUrl of [
    "WSS://relay.example.test/v1/browser?ticket=uppercase",
    "wss://relay.example.test/v1/browser?ticket=whitespace ",
  ]) {
    const result = relaySessionDescriptorSchema.safeParse({ ...descriptor, connectUrl });
    assert.equal(result.success, false, `${connectUrl} must fail without throwing`);
  }
  assert.throws(() => relaySessionDescriptorSchema.parse({ ...descriptor, expiresAt: "tomorrow" }));
  assert.throws(() =>
    relaySessionDescriptorSchema.parse({ ...descriptor, workspaceId: IDS.workspace }),
  );
});

test("session.ready is the only legal first Browser WebSocket frame", () => {
  assert.deepEqual(parseRelayBrowserFirstControlFrame(sessionReady()), sessionReady());
  assert.equal(
    relayMessageSchemaV11.safeParse(sessionReady()).success,
    false,
    "Control frames must stay outside the Relay Wire 1.1 data-plane union",
  );
  assert.equal(relayBrowserFirstControlFrameSchema.safeParse(sessionReady()).success, true);
  assert.equal(
    relayBrowserControlMessageSchema.safeParse({
      type: "workspace.status",
      workspaceId: IDS.workspace,
      status: "online",
    }).success,
    true,
  );
  assert.equal(
    relayBrowserFirstControlFrameSchema.safeParse({
      type: "workspace.status",
      workspaceId: IDS.workspace,
      status: "online",
    }).success,
    false,
  );
});

test("Control 1.0 exposes explicit browser and companion direction allowlists", () => {
  assert.deepEqual(
    RELAY_CONTROL_MESSAGE_TYPES_BY_DIRECTION[RELAY_CONTROL_DIRECTIONS.relayToBrowser],
    RELAY_BROWSER_CONTROL_MESSAGE_TYPE_VALUES,
  );
  assert.equal(
    isRelayControlMessageTypeAllowed(RELAY_CONTROL_DIRECTIONS.relayToBrowser, "session.ready"),
    true,
  );
  assert.equal(
    isRelayControlMessageTypeAllowed(RELAY_CONTROL_DIRECTIONS.browserToRelay, "session.ready"),
    false,
  );
  assert.equal(
    isRelayControlMessageTypeAllowed(RELAY_CONTROL_DIRECTIONS.relayToCompanion, "session.ready"),
    false,
  );
  assert.equal(
    isRelayControlMessageTypeAllowed(RELAY_CONTROL_DIRECTIONS.companionToRelay, "session.ready"),
    false,
  );

  assert.deepEqual(RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION[RELAY_WSS_DIRECTIONS.peerToRelay], [
    "runtime.request",
    "runtime.ack",
  ]);
  assert.deepEqual(RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION[RELAY_WSS_DIRECTIONS.relayToPeer], [
    "session.ready",
    "workspace.status",
    "session.error",
    "runtime.response",
    "runtime.event",
    "runtime.gap",
    "interaction.request",
    "interaction.resolved",
    "interaction.cancelled",
  ]);
  assert.equal(
    isRelayBrowserWssMessageTypeAllowed(RELAY_WSS_DIRECTIONS.peerToRelay, "runtime.ack"),
    true,
  );
  assert.equal(
    isRelayBrowserWssMessageTypeAllowed(RELAY_WSS_DIRECTIONS.peerToRelay, "runtime.response"),
    false,
  );
  assert.equal(
    isRelayBrowserWssMessageTypeAllowed(RELAY_WSS_DIRECTIONS.relayToPeer, "session.ready"),
    true,
  );
  assert.equal(
    isRelayBrowserWssMessageTypeAllowed(RELAY_WSS_DIRECTIONS.relayToPeer, "runtime.encrypted"),
    false,
  );

  assert.deepEqual(
    RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION[RELAY_WSS_DIRECTIONS.relayToPeer],
    ["runtime.request", "runtime.ack"],
  );
  assert.deepEqual(
    RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION[RELAY_WSS_DIRECTIONS.peerToRelay],
    [
      "device.connect",
      "runtime.response",
      "runtime.event",
      "runtime.gap",
      "interaction.request",
      "interaction.resolved",
      "interaction.cancelled",
    ],
  );
  assert.equal(
    isRelayCompanionWssMessageTypeAllowed(RELAY_WSS_DIRECTIONS.peerToRelay, "device.connect"),
    true,
  );
  assert.equal(
    isRelayCompanionWssMessageTypeAllowed(RELAY_WSS_DIRECTIONS.peerToRelay, "session.ready"),
    false,
  );
});

test("every stable Relay client error code is accepted exactly once", () => {
  assert.equal(new Set(RELAY_CLIENT_ERROR_CODE_VALUES).size, RELAY_CLIENT_ERROR_CODE_VALUES.length);
  assert.deepEqual(Object.values(RELAY_CLIENT_ERROR_CODES), [...RELAY_CLIENT_ERROR_CODE_VALUES]);
  for (const code of RELAY_CLIENT_ERROR_CODE_VALUES) {
    assert.equal(relayClientErrorCodeSchema.parse(code), code);
  }
  assert.deepEqual(
    relayBrowserControlMessageSchema.parse({
      type: "session.error",
      code: RELAY_CLIENT_ERROR_CODES.controllerConflict,
      retryable: false,
    }),
    {
      type: "session.error",
      code: "CONTROLLER_CONFLICT",
      retryable: false,
    },
  );
  assert.equal(relayClientErrorCodeSchema.safeParse("UNKNOWN_RELAY_ERROR").success, false);
});

test("handshake failures stay outside authenticated session.error frames", () => {
  assert.deepEqual(Object.values(RELAY_BROWSER_HANDSHAKE_ERROR_CODES), [
    ...RELAY_BROWSER_HANDSHAKE_ERROR_CODE_VALUES,
  ]);
  for (const code of RELAY_BROWSER_HANDSHAKE_ERROR_CODE_VALUES) {
    assert.equal(relayBrowserHandshakeErrorCodeSchema.parse(code), code);
    assert.equal(
      relayBrowserControlMessageSchema.safeParse({
        type: "session.error",
        code,
        retryable: false,
      }).success,
      false,
    );
  }
});
