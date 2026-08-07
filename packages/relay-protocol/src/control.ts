import { z } from "zod/v4";
import { RELAY_MESSAGE_TYPES_V11, workspaceIdSchema } from "./index.ts";

export const RELAY_CONTROL_VERSION = "1.0" as const;
export const RELAY_BROWSER_PROTOCOL_VERSION = "1.1" as const;

/**
 * Authentication failures happen before the Browser WebSocket is accepted. They are HTTP upgrade
 * errors and must never be sent as an authenticated Control frame.
 */
export const RELAY_BROWSER_HANDSHAKE_ERROR_CODES = {
  sessionTicketInvalid: "SESSION_TICKET_INVALID",
  sessionTicketExpired: "SESSION_TICKET_EXPIRED",
  sessionTicketAlreadyUsed: "SESSION_TICKET_ALREADY_USED",
  originNotAllowed: "ORIGIN_NOT_ALLOWED",
} as const;

export const RELAY_BROWSER_HANDSHAKE_ERROR_CODE_VALUES = [
  RELAY_BROWSER_HANDSHAKE_ERROR_CODES.sessionTicketInvalid,
  RELAY_BROWSER_HANDSHAKE_ERROR_CODES.sessionTicketExpired,
  RELAY_BROWSER_HANDSHAKE_ERROR_CODES.sessionTicketAlreadyUsed,
  RELAY_BROWSER_HANDSHAKE_ERROR_CODES.originNotAllowed,
] as const;

export const relayBrowserHandshakeErrorCodeSchema = z.enum(
  RELAY_BROWSER_HANDSHAKE_ERROR_CODE_VALUES,
);

/** Errors observable only after the authenticated `session.ready` first frame. */
export const RELAY_CLIENT_ERROR_CODES = {
  workspaceNotFound: "WORKSPACE_NOT_FOUND",
  workspaceOffline: "WORKSPACE_OFFLINE",
  controllerConflict: "CONTROLLER_CONFLICT",
  protocolVersionUnsupported: "RELAY_PROTOCOL_VERSION_UNSUPPORTED",
  rateLimited: "RATE_LIMITED",
  internalError: "RELAY_INTERNAL_ERROR",
} as const;

export const RELAY_CLIENT_ERROR_CODE_VALUES = [
  RELAY_CLIENT_ERROR_CODES.workspaceNotFound,
  RELAY_CLIENT_ERROR_CODES.workspaceOffline,
  RELAY_CLIENT_ERROR_CODES.controllerConflict,
  RELAY_CLIENT_ERROR_CODES.protocolVersionUnsupported,
  RELAY_CLIENT_ERROR_CODES.rateLimited,
  RELAY_CLIENT_ERROR_CODES.internalError,
] as const;

export const relayClientErrorCodeSchema = z.enum(RELAY_CLIENT_ERROR_CODE_VALUES);

export const relayBrowserSessionIdSchema = z.string().min(1).brand<"RelayBrowserSessionId">();

const secureWebSocketUrlSchema = z
  .string()
  .regex(/^wss:\/\/\S+$/u, "connectUrl must use wss:// without whitespace")
  .url();

export const relaySessionDescriptorSchema = z
  .object({
    connectUrl: secureWebSocketUrlSchema,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .readonly();

export const RELAY_WORKSPACE_STATUSES = ["online", "offline"] as const;
export const relayWorkspaceStatusSchema = z.enum(RELAY_WORKSPACE_STATUSES);

export const RELAY_BROWSER_CONTROL_MESSAGE_TYPES = {
  sessionReady: "session.ready",
  workspaceStatus: "workspace.status",
  sessionError: "session.error",
} as const;

export const RELAY_BROWSER_CONTROL_MESSAGE_TYPE_VALUES = [
  RELAY_BROWSER_CONTROL_MESSAGE_TYPES.sessionReady,
  RELAY_BROWSER_CONTROL_MESSAGE_TYPES.workspaceStatus,
  RELAY_BROWSER_CONTROL_MESSAGE_TYPES.sessionError,
] as const;

export const relaySessionReadyControlMessageSchema = z
  .object({
    type: z.literal(RELAY_BROWSER_CONTROL_MESSAGE_TYPES.sessionReady),
    controlVersion: z.literal(RELAY_CONTROL_VERSION),
    relayProtocolVersion: z.literal(RELAY_BROWSER_PROTOCOL_VERSION),
    sessionId: relayBrowserSessionIdSchema,
    workspaceId: workspaceIdSchema,
    workspaceStatus: relayWorkspaceStatusSchema,
  })
  .strict()
  .readonly();

export const relayWorkspaceStatusControlMessageSchema = z
  .object({
    type: z.literal(RELAY_BROWSER_CONTROL_MESSAGE_TYPES.workspaceStatus),
    workspaceId: workspaceIdSchema,
    status: relayWorkspaceStatusSchema,
  })
  .strict()
  .readonly();

export const relaySessionErrorControlMessageSchema = z
  .object({
    type: z.literal(RELAY_BROWSER_CONTROL_MESSAGE_TYPES.sessionError),
    code: relayClientErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict()
  .readonly();

export const relayBrowserControlMessageSchema = z.discriminatedUnion("type", [
  relaySessionReadyControlMessageSchema,
  relayWorkspaceStatusControlMessageSchema,
  relaySessionErrorControlMessageSchema,
]);

/** Browser WebSocket connections must validate their first received frame with this schema. */
export const relayBrowserFirstControlFrameSchema = relaySessionReadyControlMessageSchema;

export function parseRelayBrowserFirstControlFrame(
  value: unknown,
): RelaySessionReadyControlMessage {
  return relayBrowserFirstControlFrameSchema.parse(value);
}

export const RELAY_CONTROL_DIRECTIONS = {
  relayToBrowser: "relay-to-browser",
  browserToRelay: "browser-to-relay",
  relayToCompanion: "relay-to-companion",
  companionToRelay: "companion-to-relay",
} as const;

export const RELAY_CONTROL_DIRECTION_VALUES = [
  RELAY_CONTROL_DIRECTIONS.relayToBrowser,
  RELAY_CONTROL_DIRECTIONS.browserToRelay,
  RELAY_CONTROL_DIRECTIONS.relayToCompanion,
  RELAY_CONTROL_DIRECTIONS.companionToRelay,
] as const;

export const relayControlDirectionSchema = z.enum(RELAY_CONTROL_DIRECTION_VALUES);

export type RelayControlDirection = z.infer<typeof relayControlDirectionSchema>;
export type RelayBrowserControlMessageType =
  (typeof RELAY_BROWSER_CONTROL_MESSAGE_TYPE_VALUES)[number];

/** Control 1.0 is Relay-to-Browser only. Data-plane frames remain governed by Relay Wire 1.1. */
export const RELAY_CONTROL_MESSAGE_TYPES_BY_DIRECTION = {
  [RELAY_CONTROL_DIRECTIONS.relayToBrowser]: RELAY_BROWSER_CONTROL_MESSAGE_TYPE_VALUES,
  [RELAY_CONTROL_DIRECTIONS.browserToRelay]: [],
  [RELAY_CONTROL_DIRECTIONS.relayToCompanion]: [],
  [RELAY_CONTROL_DIRECTIONS.companionToRelay]: [],
} as const satisfies Readonly<
  Record<RelayControlDirection, readonly RelayBrowserControlMessageType[]>
>;

export function isRelayControlMessageTypeAllowed(
  direction: RelayControlDirection,
  messageType: string,
): messageType is RelayBrowserControlMessageType {
  const allowed: readonly string[] = RELAY_CONTROL_MESSAGE_TYPES_BY_DIRECTION[direction];
  return allowed.includes(messageType);
}

export const RELAY_WSS_DIRECTIONS = {
  relayToPeer: "relay-to-peer",
  peerToRelay: "peer-to-relay",
} as const;

export const RELAY_WSS_DIRECTION_VALUES = [
  RELAY_WSS_DIRECTIONS.relayToPeer,
  RELAY_WSS_DIRECTIONS.peerToRelay,
] as const;

export const relayWssDirectionSchema = z.enum(RELAY_WSS_DIRECTION_VALUES);
export type RelayWssDirection = z.infer<typeof relayWssDirectionSchema>;

/**
 * P0 Browser WebSocket direction contract. `runtime.ack` is a Wire 1.1 data-plane frame,
 * not a Control frame. `runtime.encrypted` is intentionally absent because P0 does not offer E2EE.
 */
export const RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION = {
  [RELAY_WSS_DIRECTIONS.relayToPeer]: [
    ...RELAY_BROWSER_CONTROL_MESSAGE_TYPE_VALUES,
    RELAY_MESSAGE_TYPES_V11.runtimeResponse,
    RELAY_MESSAGE_TYPES_V11.runtimeEvent,
    RELAY_MESSAGE_TYPES_V11.runtimeGap,
    RELAY_MESSAGE_TYPES_V11.interactionRequest,
    RELAY_MESSAGE_TYPES_V11.interactionResolved,
    RELAY_MESSAGE_TYPES_V11.interactionCancelled,
  ],
  [RELAY_WSS_DIRECTIONS.peerToRelay]: [
    RELAY_MESSAGE_TYPES_V11.runtimeRequest,
    RELAY_MESSAGE_TYPES_V11.runtimeAck,
  ],
} as const satisfies Readonly<Record<RelayWssDirection, readonly string[]>>;

/**
 * P0 Companion WebSocket direction contract. A Cloud Relay must additionally require
 * `device.connect` as the Companion connection's first frame.
 */
export const RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION = {
  [RELAY_WSS_DIRECTIONS.relayToPeer]: [
    RELAY_MESSAGE_TYPES_V11.runtimeRequest,
    RELAY_MESSAGE_TYPES_V11.runtimeAck,
  ],
  [RELAY_WSS_DIRECTIONS.peerToRelay]: [
    RELAY_MESSAGE_TYPES_V11.deviceConnect,
    RELAY_MESSAGE_TYPES_V11.runtimeResponse,
    RELAY_MESSAGE_TYPES_V11.runtimeEvent,
    RELAY_MESSAGE_TYPES_V11.runtimeGap,
    RELAY_MESSAGE_TYPES_V11.interactionRequest,
    RELAY_MESSAGE_TYPES_V11.interactionResolved,
    RELAY_MESSAGE_TYPES_V11.interactionCancelled,
  ],
} as const satisfies Readonly<Record<RelayWssDirection, readonly string[]>>;

function includesMessageType(
  allowedByDirection: Readonly<Record<RelayWssDirection, readonly string[]>>,
  direction: RelayWssDirection,
  messageType: string,
): boolean {
  return allowedByDirection[direction].includes(messageType);
}

export function isRelayBrowserWssMessageTypeAllowed(
  direction: RelayWssDirection,
  messageType: string,
): boolean {
  return includesMessageType(RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION, direction, messageType);
}

export function isRelayCompanionWssMessageTypeAllowed(
  direction: RelayWssDirection,
  messageType: string,
): boolean {
  return includesMessageType(
    RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION,
    direction,
    messageType,
  );
}

export type RelayClientErrorCode = z.infer<typeof relayClientErrorCodeSchema>;
export type RelayBrowserHandshakeErrorCode = z.infer<typeof relayBrowserHandshakeErrorCodeSchema>;
export type RelayBrowserSessionId = z.infer<typeof relayBrowserSessionIdSchema>;
export type RelaySessionDescriptor = z.infer<typeof relaySessionDescriptorSchema>;
export type RelayWorkspaceStatus = z.infer<typeof relayWorkspaceStatusSchema>;
export type RelaySessionReadyControlMessage = z.infer<typeof relaySessionReadyControlMessageSchema>;
export type RelayWorkspaceStatusControlMessage = z.infer<
  typeof relayWorkspaceStatusControlMessageSchema
>;
export type RelaySessionErrorControlMessage = z.infer<typeof relaySessionErrorControlMessageSchema>;
export type RelayBrowserControlMessage = z.infer<typeof relayBrowserControlMessageSchema>;
export type RelayBrowserFirstControlFrame = z.infer<typeof relayBrowserFirstControlFrameSchema>;
