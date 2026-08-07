import {
  relayInteractionRequestSchemaV11,
  relayRequestMethodSchemasV11,
  type RelayInteractionRequestV11,
} from "@roll-agent/relay-protocol";
import { relayClientErrorCodeSchema } from "@roll-agent/relay-protocol/control";
import { z } from "zod/v4";

const relayThreadIdSchema =
  relayRequestMethodSchemasV11["thread.open"].params.def.innerType.shape.threadId;
const relayTurnIdSchema =
  relayRequestMethodSchemasV11["turn.cancel"].params.def.innerType.shape.turnId;
const relayThreadSnapshotWireSchema = relayRequestMethodSchemasV11["thread.snapshot"].result;

export const RELAY_CONNECTION_STATUSES = {
  idle: "idle",
  connecting: "connecting",
  connected: "connected",
  reconnecting: "reconnecting",
  closed: "closed",
} as const;

export const relayConnectionStateSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal(RELAY_CONNECTION_STATUSES.idle) })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal(RELAY_CONNECTION_STATUSES.connecting),
      attempt: z.number().int().positive(),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal(RELAY_CONNECTION_STATUSES.connected),
      workspaceStatus: z.enum(["online", "offline"]),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal(RELAY_CONNECTION_STATUSES.reconnecting),
      attempt: z.number().int().positive(),
      retryAt: z.string().datetime({ offset: true }),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal(RELAY_CONNECTION_STATUSES.closed),
      reason: z.enum(["client", "session", "transport", "protocol"]),
    })
    .strict()
    .readonly(),
]);

export const RELAY_CLIENT_TRANSPORT_ERROR_CODES = {
  aborted: "ABORTED",
  closed: "CLIENT_CLOSED",
  connectionUnavailable: "CONNECTION_UNAVAILABLE",
  invalidSession: "INVALID_SESSION",
  outcomeUnknown: "OUTCOME_UNKNOWN",
  protocolError: "PROTOCOL_ERROR",
  requestTimeout: "REQUEST_TIMEOUT",
  transportError: "TRANSPORT_ERROR",
  workspaceOffline: "WORKSPACE_OFFLINE",
} as const;

export const relayClientTransportErrorCodeSchema = z.enum(RELAY_CLIENT_TRANSPORT_ERROR_CODES);

const relayClientErrorBaseFields = {
  message: z.string(),
  retryable: z.boolean(),
} as const;

export const relayClientErrorDetailsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("transport"),
      ...relayClientErrorBaseFields,
      code: relayClientTransportErrorCodeSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("session"),
      ...relayClientErrorBaseFields,
      code: relayClientErrorCodeSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("remote"),
      ...relayClientErrorBaseFields,
      code: z.string().min(1),
    })
    .strict()
    .readonly(),
]);

export const relayLiveAssistantMessageSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("streaming"),
      streamId: z.string().uuid(),
      text: z.string(),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("completed"),
      streamId: z.string().uuid(),
      text: z.string(),
    })
    .strict()
    .readonly(),
]);

const relayInteractionTerminalFields = {
  interactionId: relayInteractionRequestSchemaV11.options[0].def.innerType.shape.interactionId,
  threadId: relayThreadIdSchema,
  turnId: relayTurnIdSchema,
  method: relayInteractionRequestSchemaV11.options[0].def.innerType.shape.method.or(
    relayInteractionRequestSchemaV11.options[1].def.innerType.shape.method,
  ),
} as const;

export const relayInteractionStateSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("pending"), request: relayInteractionRequestSchemaV11 })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("responding"), request: relayInteractionRequestSchemaV11 })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("resolved"), ...relayInteractionTerminalFields })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("cancelled"), ...relayInteractionTerminalFields })
    .strict()
    .readonly(),
]);

export const relayTurnStateSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("idle") })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("running"), turnId: relayTurnIdSchema })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("cancelling"), turnId: relayTurnIdSchema })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("completed"), turnId: relayTurnIdSchema })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("cancelled"), turnId: relayTurnIdSchema })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("failed"),
      turnId: relayTurnIdSchema,
      stage: z.enum(["bootstrap", "plan", "execute"]),
    })
    .strict()
    .readonly(),
]);

const relayThreadViewFields = {
  threadId: relayThreadIdSchema,
  liveAssistantMessages: z.array(relayLiveAssistantMessageSchema).readonly(),
  interactions: z.array(relayInteractionStateSchema).readonly(),
  turn: relayTurnStateSchema,
} as const;

export const relayThreadViewSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("loading"),
      ...relayThreadViewFields,
      snapshot: z.null(),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("ready"),
      ...relayThreadViewFields,
      snapshot: relayThreadSnapshotWireSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("error"),
      ...relayThreadViewFields,
      snapshot: relayThreadSnapshotWireSchema.nullable(),
      error: relayClientErrorDetailsSchema,
    })
    .strict()
    .readonly(),
]);

export type RelayConnectionState = z.output<typeof relayConnectionStateSchema>;
export type RelayClientTransportErrorCode = z.output<typeof relayClientTransportErrorCodeSchema>;
export type RelayClientErrorDetails = z.output<typeof relayClientErrorDetailsSchema>;
export type RelayLiveAssistantMessage = z.output<typeof relayLiveAssistantMessageSchema>;
export type RelayInteractionState = z.output<typeof relayInteractionStateSchema>;
export type RelayTurnState = z.output<typeof relayTurnStateSchema>;
export type RelayThreadView = z.output<typeof relayThreadViewSchema>;

export function getPendingInteractionRequest(
  interaction: RelayInteractionState,
): RelayInteractionRequestV11 | undefined {
  return interaction.status === "pending" || interaction.status === "responding"
    ? interaction.request
    : undefined;
}
