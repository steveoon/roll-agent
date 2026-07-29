import { z } from "zod/v4";
import { RUNTIME_METHODS, jsonValueSchema, runtimeEventEnvelopeSchema } from "@roll-agent/protocol";

export const COMPANION_RELAY_PROTOCOL_VERSION = "1.0" as const;

export const deviceIdSchema = z.string().uuid().brand<"DeviceId">();
export const workspaceIdSchema = z.string().uuid().brand<"WorkspaceId">();
export const relayRequestIdSchema = z.string().uuid().brand<"RelayRequestId">();

export const relayDeviceConnectSchema = z
  .object({
    type: z.literal("device.connect"),
    protocolVersion: z.literal(COMPANION_RELAY_PROTOCOL_VERSION),
    deviceId: deviceIdSchema,
    pairingToken: z.string().min(16),
  })
  .strict()
  .readonly();

export const relayRuntimeRequestSchema = z
  .object({
    type: z.literal("runtime.request"),
    requestId: relayRequestIdSchema,
    workspaceId: workspaceIdSchema,
    method: z.enum(Object.values(RUNTIME_METHODS)),
    params: jsonValueSchema,
  })
  .strict()
  .readonly();

export const relayRuntimeResponseSchema = z
  .object({
    type: z.literal("runtime.response"),
    requestId: relayRequestIdSchema,
    workspaceId: workspaceIdSchema,
    result: jsonValueSchema.optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        retryable: z.boolean(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();

export const relayRuntimeEventSchema = z
  .object({
    type: z.literal("runtime.event"),
    workspaceId: workspaceIdSchema,
    relaySequence: z.number().int().nonnegative(),
    event: runtimeEventEnvelopeSchema,
  })
  .strict()
  .readonly();

export const relayAckSchema = z
  .object({
    type: z.literal("runtime.ack"),
    workspaceId: workspaceIdSchema,
    throughRelaySequence: z.number().int().min(-1),
  })
  .strict()
  .readonly();

export const relayGapSchema = z
  .object({
    type: z.literal("runtime.gap"),
    workspaceId: workspaceIdSchema,
    fromRelaySequence: z.number().int().nonnegative(),
    throughRelaySequence: z.number().int().nonnegative(),
    recovery: z.literal("thread.snapshot"),
  })
  .strict()
  .readonly();

export const relayEncryptedMessageSchema = z
  .object({
    type: z.literal("runtime.encrypted"),
    workspaceId: workspaceIdSchema,
    envelopeId: z.string().uuid(),
    payloadKind: z.enum(["request", "response", "event"]),
    requestId: relayRequestIdSchema.optional(),
    relaySequence: z.number().int().nonnegative().optional(),
    algorithm: z.string().min(1),
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict()
  .readonly();

export const relayMessageSchema = z.discriminatedUnion("type", [
  relayDeviceConnectSchema,
  relayRuntimeRequestSchema,
  relayRuntimeResponseSchema,
  relayRuntimeEventSchema,
  relayAckSchema,
  relayGapSchema,
  relayEncryptedMessageSchema,
]);

export type DeviceId = z.infer<typeof deviceIdSchema>;
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type RelayRequestId = z.infer<typeof relayRequestIdSchema>;
export type RelayMessage = z.infer<typeof relayMessageSchema>;
export type RelayRuntimeRequest = z.infer<typeof relayRuntimeRequestSchema>;
export type RelayRuntimeResponse = z.infer<typeof relayRuntimeResponseSchema>;
export type RelayRuntimeEvent = z.infer<typeof relayRuntimeEventSchema>;
export type RelayGap = z.infer<typeof relayGapSchema>;
export type RelayEncryptedMessage = z.infer<typeof relayEncryptedMessageSchema>;
