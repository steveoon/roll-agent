import {
  RUNTIME_SERVER_REQUEST_METHODS,
  TOOL_OUTCOME_KINDS,
  approvalIdSchema,
  approvalExplanationSchema,
  approvalRequestResultSchema,
  getApprovalExplanation,
  interactionIdSchema,
  jsonValueSchema,
  normalizeUserInputResult,
  operationGetResultSchema,
  operationViewSchema,
  pendingApprovalSchema,
  projectThreadSnapshotForVersion,
  runtimeEventEnvelopeSchema,
  runtimeEventEnvelopeV11Schema,
  runtimeMethodSchemasV11,
  runtimeInstanceIdSchema,
  streamIdSchema,
  threadIdSchema,
  threadSnapshotV11Schema,
  timestampSchema,
  turnIdSchema,
  userInputFormSchema,
  userInputResultSchema,
  type JsonValue,
  type OperationView,
  type PendingApproval,
  type ThreadSnapshotV11,
} from "@roll-agent/protocol";
import { z } from "zod/v4";

export const SUPPORTED_RELAY_PROTOCOL_VERSIONS = ["1.1", "1.0"] as const;
export type RelayProtocolVersion = (typeof SUPPORTED_RELAY_PROTOCOL_VERSIONS)[number];
export const LATEST_RELAY_PROTOCOL_VERSION = SUPPORTED_RELAY_PROTOCOL_VERSIONS[0];

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_PROTOCOL_VERSION = "1.0" as const;

/** @deprecated The one-argument Companion connection API remains pinned to Wire 1.0. */
export const COMPANION_RELAY_PROTOCOL_VERSION = RELAY_PROTOCOL_VERSION;

export const RELAY_MESSAGE_TYPES_V10 = {
  deviceConnect: "device.connect",
  runtimeRequest: "runtime.request",
  runtimeResponse: "runtime.response",
  runtimeEvent: "runtime.event",
  runtimeAck: "runtime.ack",
  runtimeGap: "runtime.gap",
  runtimeEncrypted: "runtime.encrypted",
} as const;

export const RELAY_MESSAGE_TYPES_V11 = {
  ...RELAY_MESSAGE_TYPES_V10,
  interactionRequest: "interaction.request",
  interactionResolved: "interaction.resolved",
  interactionCancelled: "interaction.cancelled",
} as const;

export const RELAY_MESSAGE_TYPE_VALUES_V10 = [
  RELAY_MESSAGE_TYPES_V10.deviceConnect,
  RELAY_MESSAGE_TYPES_V10.runtimeRequest,
  RELAY_MESSAGE_TYPES_V10.runtimeResponse,
  RELAY_MESSAGE_TYPES_V10.runtimeEvent,
  RELAY_MESSAGE_TYPES_V10.runtimeAck,
  RELAY_MESSAGE_TYPES_V10.runtimeGap,
  RELAY_MESSAGE_TYPES_V10.runtimeEncrypted,
] as const;

export const RELAY_MESSAGE_TYPE_VALUES_V11 = [
  ...RELAY_MESSAGE_TYPE_VALUES_V10,
  RELAY_MESSAGE_TYPES_V11.interactionRequest,
  RELAY_MESSAGE_TYPES_V11.interactionResolved,
  RELAY_MESSAGE_TYPES_V11.interactionCancelled,
] as const;

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_MESSAGE_TYPES = RELAY_MESSAGE_TYPES_V10;
/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_MESSAGE_TYPE_VALUES = RELAY_MESSAGE_TYPE_VALUES_V10;

/**
 * Relay Wire 1.0 is intentionally independent from the latest Runtime registry.
 * New Runtime methods never become remotely callable without a Relay version change.
 */
export const RELAY_REQUEST_METHODS_V10 = {
  initialize: "initialize",
  threadList: "thread.list",
  threadCreate: "thread.create",
  threadOpen: "thread.open",
  threadSnapshot: "thread.snapshot",
  threadRename: "thread.rename",
  threadDelete: "thread.delete",
  threadDetach: "thread.detach",
  threadCapabilities: "thread.capabilities",
  turnStart: "turn.start",
  turnCancel: "turn.cancel",
  approvalRespond: "approval.respond",
  operationGet: "operation.get",
  approvalCandidate: "approval.candidate",
} as const;

export const RELAY_REQUEST_METHODS_V11 = {
  initialize: "initialize",
  threadList: "thread.list",
  threadCreate: "thread.create",
  threadOpen: "thread.open",
  threadSnapshot: "thread.snapshot",
  threadRename: "thread.rename",
  threadDelete: "thread.delete",
  threadDetach: "thread.detach",
  threadCapabilities: "thread.capabilities",
  turnStart: "turn.start",
  turnCancel: "turn.cancel",
  operationGet: "operation.get",
  interactionCandidate: "interaction.candidate",
} as const;

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_REQUEST_METHODS = RELAY_REQUEST_METHODS_V10;

export type RelayRequestMethod =
  (typeof RELAY_REQUEST_METHODS_V10)[keyof typeof RELAY_REQUEST_METHODS_V10];

export const RELAY_REQUEST_METHOD_VALUES_V10 = [
  RELAY_REQUEST_METHODS_V10.initialize,
  RELAY_REQUEST_METHODS_V10.threadList,
  RELAY_REQUEST_METHODS_V10.threadCreate,
  RELAY_REQUEST_METHODS_V10.threadOpen,
  RELAY_REQUEST_METHODS_V10.threadSnapshot,
  RELAY_REQUEST_METHODS_V10.threadRename,
  RELAY_REQUEST_METHODS_V10.threadDelete,
  RELAY_REQUEST_METHODS_V10.threadDetach,
  RELAY_REQUEST_METHODS_V10.threadCapabilities,
  RELAY_REQUEST_METHODS_V10.turnStart,
  RELAY_REQUEST_METHODS_V10.turnCancel,
  RELAY_REQUEST_METHODS_V10.approvalRespond,
  RELAY_REQUEST_METHODS_V10.operationGet,
  RELAY_REQUEST_METHODS_V10.approvalCandidate,
] as const satisfies readonly RelayRequestMethod[];

export const RELAY_REQUEST_METHOD_VALUES_V11 = [
  RELAY_REQUEST_METHODS_V11.initialize,
  RELAY_REQUEST_METHODS_V11.threadList,
  RELAY_REQUEST_METHODS_V11.threadCreate,
  RELAY_REQUEST_METHODS_V11.threadOpen,
  RELAY_REQUEST_METHODS_V11.threadSnapshot,
  RELAY_REQUEST_METHODS_V11.threadRename,
  RELAY_REQUEST_METHODS_V11.threadDelete,
  RELAY_REQUEST_METHODS_V11.threadDetach,
  RELAY_REQUEST_METHODS_V11.threadCapabilities,
  RELAY_REQUEST_METHODS_V11.turnStart,
  RELAY_REQUEST_METHODS_V11.turnCancel,
  RELAY_REQUEST_METHODS_V11.operationGet,
  RELAY_REQUEST_METHODS_V11.interactionCandidate,
] as const;

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_REQUEST_METHOD_VALUES = RELAY_REQUEST_METHOD_VALUES_V10;

export const RELAY_REQUEST_METHOD_DISPOSITIONS_V10 = {
  [RELAY_REQUEST_METHODS_V10.initialize]: "local-only",
  [RELAY_REQUEST_METHODS_V10.threadList]: "query",
  [RELAY_REQUEST_METHODS_V10.threadCreate]: "mutation",
  [RELAY_REQUEST_METHODS_V10.threadOpen]: "query",
  [RELAY_REQUEST_METHODS_V10.threadSnapshot]: "query",
  [RELAY_REQUEST_METHODS_V10.threadRename]: "mutation",
  [RELAY_REQUEST_METHODS_V10.threadDelete]: "mutation",
  [RELAY_REQUEST_METHODS_V10.threadDetach]: "mutation",
  [RELAY_REQUEST_METHODS_V10.threadCapabilities]: "query",
  [RELAY_REQUEST_METHODS_V10.turnStart]: "mutation",
  [RELAY_REQUEST_METHODS_V10.turnCancel]: "mutation",
  [RELAY_REQUEST_METHODS_V10.approvalRespond]: "mutation",
  [RELAY_REQUEST_METHODS_V10.operationGet]: "query",
  [RELAY_REQUEST_METHODS_V10.approvalCandidate]: "mutation",
} as const satisfies Readonly<Record<RelayRequestMethod, "query" | "mutation" | "local-only">>;

export const RELAY_REQUEST_METHOD_DISPOSITIONS_V11 = {
  [RELAY_REQUEST_METHODS_V11.initialize]: "local-only",
  [RELAY_REQUEST_METHODS_V11.threadList]: "query",
  [RELAY_REQUEST_METHODS_V11.threadCreate]: "mutation",
  [RELAY_REQUEST_METHODS_V11.threadOpen]: "query",
  [RELAY_REQUEST_METHODS_V11.threadSnapshot]: "query",
  [RELAY_REQUEST_METHODS_V11.threadRename]: "mutation",
  [RELAY_REQUEST_METHODS_V11.threadDelete]: "mutation",
  [RELAY_REQUEST_METHODS_V11.threadDetach]: "mutation",
  [RELAY_REQUEST_METHODS_V11.threadCapabilities]: "query",
  [RELAY_REQUEST_METHODS_V11.turnStart]: "mutation",
  [RELAY_REQUEST_METHODS_V11.turnCancel]: "mutation",
  [RELAY_REQUEST_METHODS_V11.operationGet]: "query",
  [RELAY_REQUEST_METHODS_V11.interactionCandidate]: "mutation",
} as const;

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_REQUEST_METHOD_DISPOSITIONS = RELAY_REQUEST_METHOD_DISPOSITIONS_V10;

export type RelayRequestMethodDisposition =
  (typeof RELAY_REQUEST_METHOD_DISPOSITIONS)[RelayRequestMethod];

export const RELAY_MUTATION_REQUEST_METHODS_V10 = [
  RELAY_REQUEST_METHODS_V10.threadCreate,
  RELAY_REQUEST_METHODS_V10.threadRename,
  RELAY_REQUEST_METHODS_V10.threadDelete,
  RELAY_REQUEST_METHODS_V10.threadDetach,
  RELAY_REQUEST_METHODS_V10.turnStart,
  RELAY_REQUEST_METHODS_V10.turnCancel,
  RELAY_REQUEST_METHODS_V10.approvalRespond,
  RELAY_REQUEST_METHODS_V10.approvalCandidate,
] as const satisfies readonly RelayRequestMethod[];

export const RELAY_MUTATION_REQUEST_METHODS_V11 = [
  RELAY_REQUEST_METHODS_V11.threadCreate,
  RELAY_REQUEST_METHODS_V11.threadRename,
  RELAY_REQUEST_METHODS_V11.threadDelete,
  RELAY_REQUEST_METHODS_V11.threadDetach,
  RELAY_REQUEST_METHODS_V11.turnStart,
  RELAY_REQUEST_METHODS_V11.turnCancel,
  RELAY_REQUEST_METHODS_V11.interactionCandidate,
] as const;

export const RELAY_LOCAL_ONLY_REQUEST_METHODS_V10 = [
  RELAY_REQUEST_METHODS_V10.initialize,
] as const satisfies readonly RelayRequestMethod[];

export const RELAY_LOCAL_ONLY_REQUEST_METHODS_V11 = [RELAY_REQUEST_METHODS_V11.initialize] as const;

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_MUTATION_REQUEST_METHODS = RELAY_MUTATION_REQUEST_METHODS_V10;
/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const RELAY_LOCAL_ONLY_REQUEST_METHODS = RELAY_LOCAL_ONLY_REQUEST_METHODS_V10;

export const RELAY_ERROR_CODES = {
  protocolVersionUnsupported: "RELAY_PROTOCOL_VERSION_UNSUPPORTED",
  invalidFrame: "RELAY_INVALID_FRAME",
  invalidParams: "INVALID_PARAMS",
  requestIdConflict: "RELAY_REQUEST_ID_CONFLICT",
  workspaceNotFound: "WORKSPACE_NOT_FOUND",
  encryptionRequired: "RELAY_ENCRYPTION_REQUIRED",
  encryptedPayloadInvalid: "ENCRYPTED_PAYLOAD_INVALID",
  localApprovalDenied: "LocalApprovalDeniedError",
  localConfirmationRequired: "LocalConfirmationRequiredError",
  companionError: "COMPANION_ERROR",
} as const;

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[keyof typeof RELAY_ERROR_CODES];

export const RELAY_ERROR_RETRYABILITY = {
  [RELAY_ERROR_CODES.protocolVersionUnsupported]: false,
  [RELAY_ERROR_CODES.invalidFrame]: false,
  [RELAY_ERROR_CODES.invalidParams]: false,
  [RELAY_ERROR_CODES.requestIdConflict]: false,
  [RELAY_ERROR_CODES.workspaceNotFound]: false,
  [RELAY_ERROR_CODES.encryptionRequired]: false,
  [RELAY_ERROR_CODES.encryptedPayloadInvalid]: false,
  [RELAY_ERROR_CODES.localApprovalDenied]: false,
  [RELAY_ERROR_CODES.localConfirmationRequired]: false,
  [RELAY_ERROR_CODES.companionError]: false,
} as const satisfies Readonly<Record<RelayErrorCode, boolean>>;

export function getRelayErrorRetryability(code: RelayErrorCode): boolean {
  return RELAY_ERROR_RETRYABILITY[code];
}

export const relayProtocolVersionSchema = z.enum(SUPPORTED_RELAY_PROTOCOL_VERSIONS);
export const deviceIdSchema = z.string().uuid().brand<"DeviceId">();
export const workspaceIdSchema = z.string().uuid().brand<"WorkspaceId">();
export const relayRequestIdSchema = z.string().uuid().brand<"RelayRequestId">();
export const relayEnvelopeIdSchema = z.string().uuid();
export const relayInteractionIdSchema = interactionIdSchema;

export const relayApprovalCandidateParamsSchema = z
  .object({
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    approvalId: approvalIdSchema,
    decision: z.enum(["approve", "reject"]),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

export const relayApprovalCandidateResultSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict()
  .readonly();

export const RELAY_INTERACTION_METHODS_V11 = {
  approvalRequest: RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
  userInputRequest: RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
} as const;

export const RELAY_INTERACTION_METHOD_VALUES_V11 = [
  RELAY_INTERACTION_METHODS_V11.approvalRequest,
  RELAY_INTERACTION_METHODS_V11.userInputRequest,
] as const;

export const relayApprovalInteractionProjectionSchemaV11 = z
  .object({
    approvalId: approvalIdSchema,
    agentName: z.string().min(1),
    toolName: z.string().min(1),
    explanation: approvalExplanationSchema.optional(),
  })
  .strict()
  .readonly();

export const relayUserInputInteractionProjectionSchemaV11 = userInputFormSchema;

const relayInteractionCandidateBaseFieldsV11 = {
  interactionId: interactionIdSchema,
  threadId: threadIdSchema,
  turnId: turnIdSchema,
} as const;

export const relayApprovalInteractionCandidateParamsSchemaV11 = z
  .object({
    ...relayInteractionCandidateBaseFieldsV11,
    method: z.literal(RELAY_INTERACTION_METHODS_V11.approvalRequest),
    candidate: approvalRequestResultSchema,
  })
  .strict()
  .readonly();

export const relayUserInputInteractionCandidateParamsSchemaV11 = z
  .object({
    ...relayInteractionCandidateBaseFieldsV11,
    method: z.literal(RELAY_INTERACTION_METHODS_V11.userInputRequest),
    candidate: userInputResultSchema,
  })
  .strict()
  .readonly();

export const relayInteractionCandidateParamsSchemaV11 = z.discriminatedUnion("method", [
  relayApprovalInteractionCandidateParamsSchemaV11,
  relayUserInputInteractionCandidateParamsSchemaV11,
]);

export const relayInteractionCandidateResultSchemaV11 = z
  .object({ accepted: z.literal(true) })
  .strict()
  .readonly();

const relayCommonRequestMethodSchemas = {
  initialize: runtimeMethodSchemasV11["initialize"],
  threadList: runtimeMethodSchemasV11["thread.list"],
  threadCreate: runtimeMethodSchemasV11["thread.create"],
  threadOpen: runtimeMethodSchemasV11["thread.open"],
  threadSnapshot: runtimeMethodSchemasV11["thread.snapshot"],
  threadRename: runtimeMethodSchemasV11["thread.rename"],
  threadDelete: runtimeMethodSchemasV11["thread.delete"],
  threadDetach: runtimeMethodSchemasV11["thread.detach"],
  threadCapabilities: runtimeMethodSchemasV11["thread.capabilities"],
  turnStart: runtimeMethodSchemasV11["turn.start"],
  turnCancel: runtimeMethodSchemasV11["turn.cancel"],
  approvalRespond: runtimeMethodSchemasV11["approval.respond"],
  operationGet: runtimeMethodSchemasV11["operation.get"],
} as const;

export const relayRequestMethodSchemasV10 = {
  [RELAY_REQUEST_METHODS_V10.initialize]: relayCommonRequestMethodSchemas.initialize,
  [RELAY_REQUEST_METHODS_V10.threadList]: relayCommonRequestMethodSchemas.threadList,
  [RELAY_REQUEST_METHODS_V10.threadCreate]: relayCommonRequestMethodSchemas.threadCreate,
  [RELAY_REQUEST_METHODS_V10.threadOpen]: relayCommonRequestMethodSchemas.threadOpen,
  [RELAY_REQUEST_METHODS_V10.threadSnapshot]: relayCommonRequestMethodSchemas.threadSnapshot,
  [RELAY_REQUEST_METHODS_V10.threadRename]: relayCommonRequestMethodSchemas.threadRename,
  [RELAY_REQUEST_METHODS_V10.threadDelete]: relayCommonRequestMethodSchemas.threadDelete,
  [RELAY_REQUEST_METHODS_V10.threadDetach]: relayCommonRequestMethodSchemas.threadDetach,
  [RELAY_REQUEST_METHODS_V10.threadCapabilities]:
    relayCommonRequestMethodSchemas.threadCapabilities,
  [RELAY_REQUEST_METHODS_V10.turnStart]: relayCommonRequestMethodSchemas.turnStart,
  [RELAY_REQUEST_METHODS_V10.turnCancel]: relayCommonRequestMethodSchemas.turnCancel,
  [RELAY_REQUEST_METHODS_V10.approvalRespond]: relayCommonRequestMethodSchemas.approvalRespond,
  [RELAY_REQUEST_METHODS_V10.operationGet]: relayCommonRequestMethodSchemas.operationGet,
  [RELAY_REQUEST_METHODS_V10.approvalCandidate]: {
    params: relayApprovalCandidateParamsSchema,
    result: relayApprovalCandidateResultSchema,
  },
} as const satisfies Readonly<
  Record<
    RelayRequestMethod,
    {
      readonly params: z.ZodType;
      readonly result: z.ZodType;
    }
  >
>;

export const relayRequestMethodSchemasV11 = {
  [RELAY_REQUEST_METHODS_V11.initialize]: relayCommonRequestMethodSchemas.initialize,
  [RELAY_REQUEST_METHODS_V11.threadList]: relayCommonRequestMethodSchemas.threadList,
  [RELAY_REQUEST_METHODS_V11.threadCreate]: relayCommonRequestMethodSchemas.threadCreate,
  [RELAY_REQUEST_METHODS_V11.threadOpen]: relayCommonRequestMethodSchemas.threadOpen,
  [RELAY_REQUEST_METHODS_V11.threadSnapshot]: relayCommonRequestMethodSchemas.threadSnapshot,
  [RELAY_REQUEST_METHODS_V11.threadRename]: relayCommonRequestMethodSchemas.threadRename,
  [RELAY_REQUEST_METHODS_V11.threadDelete]: relayCommonRequestMethodSchemas.threadDelete,
  [RELAY_REQUEST_METHODS_V11.threadDetach]: relayCommonRequestMethodSchemas.threadDetach,
  [RELAY_REQUEST_METHODS_V11.threadCapabilities]:
    relayCommonRequestMethodSchemas.threadCapabilities,
  [RELAY_REQUEST_METHODS_V11.turnStart]: relayCommonRequestMethodSchemas.turnStart,
  [RELAY_REQUEST_METHODS_V11.turnCancel]: relayCommonRequestMethodSchemas.turnCancel,
  [RELAY_REQUEST_METHODS_V11.operationGet]: relayCommonRequestMethodSchemas.operationGet,
  [RELAY_REQUEST_METHODS_V11.interactionCandidate]: {
    params: relayInteractionCandidateParamsSchemaV11,
    result: relayInteractionCandidateResultSchemaV11,
  },
} as const;

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const relayRequestMethodSchemas = relayRequestMethodSchemasV10;

export type RelayRequestParams<TMethod extends RelayRequestMethod> = z.infer<
  (typeof relayRequestMethodSchemas)[TMethod]["params"]
>;
export type RelayRequestResult<TMethod extends RelayRequestMethod> = z.infer<
  (typeof relayRequestMethodSchemas)[TMethod]["result"]
>;

export function isRelayRequestMethod(value: string): value is RelayRequestMethod {
  return Object.hasOwn(relayRequestMethodSchemas, value);
}

export function getRelayRequestMethodDisposition(
  value: string,
): RelayRequestMethodDisposition | undefined {
  return isRelayRequestMethod(value) ? RELAY_REQUEST_METHOD_DISPOSITIONS[value] : undefined;
}

export function isRelayMutationRequestMethod(
  method: RelayRequestMethod,
): method is (typeof RELAY_MUTATION_REQUEST_METHODS)[number] {
  return RELAY_REQUEST_METHOD_DISPOSITIONS[method] === "mutation";
}

export function parseRelayRequestParams<TMethod extends RelayRequestMethod>(
  method: TMethod,
  value: unknown,
): RelayRequestParams<TMethod> {
  return relayRequestMethodSchemas[method].params.parse(value) as RelayRequestParams<TMethod>;
}

export function parseRelayRequestResult<TMethod extends RelayRequestMethod>(
  method: TMethod,
  value: unknown,
): RelayRequestResult<TMethod> {
  return relayRequestMethodSchemas[method].result.parse(value) as RelayRequestResult<TMethod>;
}

export const relayDeviceConnectSchema = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES.deviceConnect),
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    deviceId: deviceIdSchema,
    pairingToken: z.string().min(16),
  })
  .strict()
  .readonly();

export const relayRuntimeRequestSchema = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES.runtimeRequest),
    requestId: relayRequestIdSchema,
    workspaceId: workspaceIdSchema,
    method: z.enum(RELAY_REQUEST_METHOD_VALUES),
    params: jsonValueSchema,
  })
  .strict()
  .readonly();

export const relayErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict()
  .readonly();

/**
 * This preserves the pre-freeze v1.0 shape: result/error are independently optional.
 * A strict exactly-one response belongs in a later Relay Wire version.
 */
export const relayRuntimeResponseSchema = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES.runtimeResponse),
    requestId: relayRequestIdSchema,
    workspaceId: workspaceIdSchema,
    result: jsonValueSchema.optional(),
    error: relayErrorSchema.optional(),
  })
  .strict()
  .readonly();

export const relayRuntimeEventSchema = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES.runtimeEvent),
    workspaceId: workspaceIdSchema,
    relaySequence: z.number().int().nonnegative(),
    event: runtimeEventEnvelopeV11Schema,
  })
  .strict()
  .readonly();

export const relayAckSchema = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES.runtimeAck),
    workspaceId: workspaceIdSchema,
    throughRelaySequence: z.number().int().min(-1),
  })
  .strict()
  .readonly();

export const relayGapSchema = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES.runtimeGap),
    workspaceId: workspaceIdSchema,
    fromRelaySequence: z.number().int().nonnegative(),
    throughRelaySequence: z.number().int().nonnegative(),
    recovery: z.literal("thread.snapshot"),
  })
  .strict()
  .readonly();

/**
 * This preserves the pre-freeze v1.0 metadata shape. Payload-kind-specific required
 * fields must be introduced under a later Relay Wire version.
 */
export const relayEncryptedMessageSchema = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES.runtimeEncrypted),
    workspaceId: workspaceIdSchema,
    envelopeId: relayEnvelopeIdSchema,
    payloadKind: z.enum(["request", "response", "event"]),
    requestId: relayRequestIdSchema.optional(),
    relaySequence: z.number().int().nonnegative().optional(),
    algorithm: z.string().min(1),
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict()
  .readonly();

export const relayDeviceConnectSchemaV10 = relayDeviceConnectSchema;
export const relayRuntimeRequestSchemaV10 = relayRuntimeRequestSchema;
export const relayRuntimeResponseSchemaV10 = relayRuntimeResponseSchema;
export const relayRuntimeEventSchemaV10 = relayRuntimeEventSchema;
export const relayAckSchemaV10 = relayAckSchema;
export const relayGapSchemaV10 = relayGapSchema;
export const relayEncryptedMessageSchemaV10 = relayEncryptedMessageSchema;

export const relaySafeToolOutcomeSchemaV11 = z
  .object({ kind: z.enum(TOOL_OUTCOME_KINDS) })
  .strict()
  .readonly();

export const relaySafeApprovalResolutionSchemaV11 = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("resolved"), decision: z.enum(["approve", "reject"]) })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("cancelled") })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("expired") })
    .strict()
    .readonly(),
]);

export const relayTimelineEventSchemaV11 = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("turn.started") })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("message.started"), streamId: streamIdSchema })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("message.delta"), streamId: streamIdSchema, delta: z.string() })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("message.completed"), streamId: streamIdSchema, text: z.string() })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("reasoning.summary.delta"),
      reasoningId: z.string().min(1),
      delta: z.string(),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("tool.started"),
      toolCallId: z.string().min(1),
      agentName: z.string().min(1),
      toolName: z.string().min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("tool.completed"),
      toolCallId: z.string().min(1),
      agentName: z.string().min(1),
      toolName: z.string().min(1),
      outcome: relaySafeToolOutcomeSchemaV11.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("approval.required"),
      approval: relayApprovalInteractionProjectionSchemaV11,
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("approval.resolved"),
      approvalId: approvalIdSchema,
      resolution: relaySafeApprovalResolutionSchemaV11,
    })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("turn.completed") })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("turn.cancelled") })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("turn.failed"), stage: z.enum(["bootstrap", "plan", "execute"]) })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("capabilities.changed") })
    .strict()
    .readonly(),
]);

export const relayRuntimeEventEnvelopeSchemaV11 = z
  .object({
    protocolVersion: z.enum(["1.1", "1.0"]),
    runtimeInstanceId: runtimeInstanceIdSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: timestampSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema.optional(),
    event: relayTimelineEventSchemaV11,
  })
  .strict()
  .readonly();

type RuntimeEventForRelayProjection = z.output<typeof runtimeEventEnvelopeSchema>["event"];

function projectRelayTimelineEventV11(
  event: RuntimeEventForRelayProjection,
): z.output<typeof relayTimelineEventSchemaV11> | undefined {
  if (event.type === "tool.output") {
    return undefined;
  }
  if (event.type === "tool.started") {
    return relayTimelineEventSchemaV11.parse({
      type: event.type,
      toolCallId: event.toolCallId,
      agentName: event.agentName,
      toolName: event.toolName,
    });
  }
  if (event.type === "tool.completed") {
    return relayTimelineEventSchemaV11.parse({
      type: event.type,
      toolCallId: event.toolCallId,
      agentName: event.agentName,
      toolName: event.toolName,
      ...(event.outcome === undefined ? {} : { outcome: { kind: event.outcome.kind } }),
    });
  }
  if (event.type === "approval.required") {
    const explanation = getApprovalExplanation(event.approval);
    return relayTimelineEventSchemaV11.parse({
      type: event.type,
      approval: {
        approvalId: event.approval.id,
        agentName: event.approval.agentName,
        toolName: event.approval.toolName,
        ...(explanation === undefined ? {} : { explanation }),
      },
    });
  }
  if (event.type === "approval.resolved") {
    const resolution =
      event.resolution.status === "resolved"
        ? { status: event.resolution.status, decision: event.resolution.decision }
        : { status: event.resolution.status };
    return relayTimelineEventSchemaV11.parse({
      type: event.type,
      approvalId: event.approvalId,
      resolution,
    });
  }
  if (event.type === "turn.cancelled") {
    return relayTimelineEventSchemaV11.parse({ type: event.type });
  }
  if (event.type === "turn.failed") {
    return relayTimelineEventSchemaV11.parse({ type: event.type, stage: event.stage });
  }
  return relayTimelineEventSchemaV11.parse(event);
}

export function projectRuntimeEventEnvelopeForRelayV11(
  value: unknown,
): z.output<typeof relayRuntimeEventEnvelopeSchemaV11> | undefined {
  const envelope = runtimeEventEnvelopeSchema.parse(value);
  const event = projectRelayTimelineEventV11(envelope.event);
  if (event === undefined) {
    return undefined;
  }
  return relayRuntimeEventEnvelopeSchemaV11.parse({
    protocolVersion: envelope.protocolVersion === "1.0" ? "1.0" : "1.1",
    runtimeInstanceId: envelope.runtimeInstanceId,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    threadId: envelope.threadId,
    ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
    event,
  });
}

function redactRelayOperationViewV11(operation: OperationView): OperationView {
  return operationViewSchema.parse({
    id: operation.id,
    sequence: operation.sequence,
    toolCallId: operation.toolCallId,
    agentName: operation.agentName,
    toolName: operation.toolName,
    createdAt: operation.createdAt,
    outcome: { kind: operation.outcome.kind },
    display: null,
  });
}

function redactRelayPendingApprovalV11(approval: PendingApproval): PendingApproval {
  const explanation = getApprovalExplanation(approval);
  return pendingApprovalSchema.parse({
    id: approval.id,
    turnId: approval.turnId,
    agentName: approval.agentName,
    toolName: approval.toolName,
    preview: explanation === undefined ? null : { explanation },
  });
}

/** Projects a Runtime snapshot into the allowlisted Relay Wire 1.1 query shape. */
export function projectRelayThreadSnapshotV11(value: unknown): ThreadSnapshotV11 {
  const legacySnapshot = threadSnapshotV11Schema.safeParse(value);
  const snapshot = legacySnapshot.success
    ? legacySnapshot.data
    : projectThreadSnapshotForVersion("1.1", value);
  return threadSnapshotV11Schema.parse({
    thread: snapshot.thread,
    messages: snapshot.messages,
    operations: {
      items: snapshot.operations.items.map(redactRelayOperationViewV11),
      nextBeforeSequence: snapshot.operations.nextBeforeSequence,
    },
    ...(snapshot.activeTurn === undefined ? {} : { activeTurn: snapshot.activeTurn }),
    pendingApprovals: snapshot.pendingApprovals.map(redactRelayPendingApprovalV11),
    transcriptCompleteness: snapshot.transcriptCompleteness,
  });
}

/** Projects an operation query result without local display or outcome details. */
export function projectRelayOperationGetResultV11(
  value: unknown,
): z.output<typeof operationGetResultSchema> {
  const result = operationGetResultSchema.parse(value);
  return operationGetResultSchema.parse({
    operation: result.operation === null ? null : redactRelayOperationViewV11(result.operation),
  });
}

const relayInteractionRequestBaseFieldsV11 = {
  workspaceId: workspaceIdSchema,
  relaySequence: z.number().int().nonnegative(),
  interactionId: interactionIdSchema,
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  expiresAt: timestampSchema,
  sensitivity: z.literal("normal"),
} as const;

export const relayApprovalInteractionRequestSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.interactionRequest),
    ...relayInteractionRequestBaseFieldsV11,
    method: z.literal(RELAY_INTERACTION_METHODS_V11.approvalRequest),
    projection: relayApprovalInteractionProjectionSchemaV11,
  })
  .strict()
  .readonly();

export const relayUserInputInteractionRequestSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.interactionRequest),
    ...relayInteractionRequestBaseFieldsV11,
    method: z.literal(RELAY_INTERACTION_METHODS_V11.userInputRequest),
    projection: relayUserInputInteractionProjectionSchemaV11,
  })
  .strict()
  .readonly();

export const relayInteractionRequestSchemaV11 = z.discriminatedUnion("method", [
  relayApprovalInteractionRequestSchemaV11,
  relayUserInputInteractionRequestSchemaV11,
]);

const relayInteractionTerminalBaseFieldsV11 = {
  workspaceId: workspaceIdSchema,
  relaySequence: z.number().int().nonnegative(),
  interactionId: interactionIdSchema,
  threadId: threadIdSchema,
  turnId: turnIdSchema,
  method: z.enum(RELAY_INTERACTION_METHOD_VALUES_V11),
} as const;

export const relayInteractionResolvedSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.interactionResolved),
    ...relayInteractionTerminalBaseFieldsV11,
  })
  .strict()
  .readonly();

export const relayInteractionCancelledSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.interactionCancelled),
    ...relayInteractionTerminalBaseFieldsV11,
  })
  .strict()
  .readonly();

export const relayDeviceConnectSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.deviceConnect),
    protocolVersion: z.literal("1.1"),
    deviceId: deviceIdSchema,
    pairingToken: z.string().min(16),
  })
  .strict()
  .readonly();

export const relayRuntimeRequestSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.runtimeRequest),
    requestId: relayRequestIdSchema,
    workspaceId: workspaceIdSchema,
    method: z.enum(RELAY_REQUEST_METHOD_VALUES_V11),
    params: jsonValueSchema,
  })
  .strict()
  .readonly();

export const relayRuntimeResponseSchemaV11 = relayRuntimeResponseSchemaV10;

export const relayRuntimeEventSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.runtimeEvent),
    workspaceId: workspaceIdSchema,
    relaySequence: z.number().int().nonnegative(),
    event: relayRuntimeEventEnvelopeSchemaV11,
  })
  .strict()
  .readonly();

export const relayAckSchemaV11 = relayAckSchemaV10;
export const relayGapSchemaV11 = relayGapSchemaV10;

export const relayEncryptedMessageSchemaV11 = z
  .object({
    type: z.literal(RELAY_MESSAGE_TYPES_V11.runtimeEncrypted),
    workspaceId: workspaceIdSchema,
    envelopeId: relayEnvelopeIdSchema,
    payloadKind: z.enum(["request", "response", "event", "interaction"]),
    requestId: relayRequestIdSchema.optional(),
    relaySequence: z.number().int().nonnegative().optional(),
    algorithm: z.string().min(1),
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict()
  .readonly();

export const relayMessageSchemasV10 = {
  [RELAY_MESSAGE_TYPES.deviceConnect]: relayDeviceConnectSchema,
  [RELAY_MESSAGE_TYPES.runtimeRequest]: relayRuntimeRequestSchema,
  [RELAY_MESSAGE_TYPES.runtimeResponse]: relayRuntimeResponseSchema,
  [RELAY_MESSAGE_TYPES.runtimeEvent]: relayRuntimeEventSchema,
  [RELAY_MESSAGE_TYPES.runtimeAck]: relayAckSchema,
  [RELAY_MESSAGE_TYPES.runtimeGap]: relayGapSchema,
  [RELAY_MESSAGE_TYPES.runtimeEncrypted]: relayEncryptedMessageSchema,
} as const;

export const relayMessageSchemaV10 = z.discriminatedUnion("type", [
  relayDeviceConnectSchema,
  relayRuntimeRequestSchema,
  relayRuntimeResponseSchema,
  relayRuntimeEventSchema,
  relayAckSchema,
  relayGapSchema,
  relayEncryptedMessageSchema,
]);

/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const relayMessageSchemas = relayMessageSchemasV10;
/** @deprecated Legacy generic Relay exports remain pinned to Wire 1.0. */
export const relayMessageSchema = relayMessageSchemaV10;

export const relayMessageSchemasV11 = {
  [RELAY_MESSAGE_TYPES_V11.deviceConnect]: relayDeviceConnectSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.runtimeRequest]: relayRuntimeRequestSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.runtimeResponse]: relayRuntimeResponseSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.runtimeEvent]: relayRuntimeEventSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.runtimeAck]: relayAckSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.runtimeGap]: relayGapSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.runtimeEncrypted]: relayEncryptedMessageSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.interactionRequest]: relayInteractionRequestSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.interactionResolved]: relayInteractionResolvedSchemaV11,
  [RELAY_MESSAGE_TYPES_V11.interactionCancelled]: relayInteractionCancelledSchemaV11,
} as const;

export const relayMessageSchemaV11 = z.discriminatedUnion("type", [
  relayDeviceConnectSchemaV11,
  relayRuntimeRequestSchemaV11,
  relayRuntimeResponseSchemaV11,
  relayRuntimeEventSchemaV11,
  relayAckSchemaV11,
  relayGapSchemaV11,
  relayEncryptedMessageSchemaV11,
  relayInteractionRequestSchemaV11,
  relayInteractionResolvedSchemaV11,
  relayInteractionCancelledSchemaV11,
]);

export interface RelayProtocolRegistry {
  readonly messageTypes: readonly string[];
  readonly messageSchema: z.ZodType;
  readonly requestMethods: readonly string[];
  readonly requestMethodSchemas: Readonly<
    Record<string, { readonly params: z.ZodType; readonly result: z.ZodType }>
  >;
  readonly requestMethodDispositions: Readonly<Record<string, "query" | "mutation" | "local-only">>;
  readonly mutationMethods: readonly string[];
  readonly localOnlyMethods: readonly string[];
}

export const RELAY_PROTOCOL_REGISTRY = {
  "1.1": {
    messageTypes: RELAY_MESSAGE_TYPE_VALUES_V11,
    messageSchema: relayMessageSchemaV11,
    requestMethods: RELAY_REQUEST_METHOD_VALUES_V11,
    requestMethodSchemas: relayRequestMethodSchemasV11,
    requestMethodDispositions: RELAY_REQUEST_METHOD_DISPOSITIONS_V11,
    mutationMethods: RELAY_MUTATION_REQUEST_METHODS_V11,
    localOnlyMethods: RELAY_LOCAL_ONLY_REQUEST_METHODS_V11,
  },
  "1.0": {
    messageTypes: RELAY_MESSAGE_TYPE_VALUES_V10,
    messageSchema: relayMessageSchemaV10,
    requestMethods: RELAY_REQUEST_METHOD_VALUES_V10,
    requestMethodSchemas: relayRequestMethodSchemasV10,
    requestMethodDispositions: RELAY_REQUEST_METHOD_DISPOSITIONS_V10,
    mutationMethods: RELAY_MUTATION_REQUEST_METHODS_V10,
    localOnlyMethods: RELAY_LOCAL_ONLY_REQUEST_METHODS_V10,
  },
} as const satisfies Readonly<Record<RelayProtocolVersion, RelayProtocolRegistry>>;

type RelayProtocolRegistryMap = typeof RELAY_PROTOCOL_REGISTRY;
type RelaySchemaParams<TDefinition> = TDefinition extends {
  readonly params: infer TSchema extends z.ZodType;
}
  ? TSchema
  : never;
type RelaySchemaResult<TDefinition> = TDefinition extends {
  readonly result: infer TSchema extends z.ZodType;
}
  ? TSchema
  : never;

export type RelayMessageForVersion<TVersion extends RelayProtocolVersion> = z.output<
  RelayProtocolRegistryMap[TVersion]["messageSchema"]
>;
export type RelayRequestMethodForVersion<TVersion extends RelayProtocolVersion> = Extract<
  keyof RelayProtocolRegistryMap[TVersion]["requestMethodSchemas"],
  string
>;
type RelayRequestMethodDefinitionForVersion<
  TVersion extends RelayProtocolVersion,
  TMethod extends RelayRequestMethodForVersion<TVersion>,
> = TMethod extends keyof RelayProtocolRegistryMap[TVersion]["requestMethodSchemas"]
  ? RelayProtocolRegistryMap[TVersion]["requestMethodSchemas"][TMethod]
  : never;
export type RelayRequestParamsForVersion<
  TVersion extends RelayProtocolVersion,
  TMethod extends RelayRequestMethodForVersion<TVersion>,
> = z.output<RelaySchemaParams<RelayRequestMethodDefinitionForVersion<TVersion, TMethod>>>;
export type RelayRequestResultForVersion<
  TVersion extends RelayProtocolVersion,
  TMethod extends RelayRequestMethodForVersion<TVersion>,
> = z.output<RelaySchemaResult<RelayRequestMethodDefinitionForVersion<TVersion, TMethod>>>;
export type RelayRequestMethodDispositionForVersion<TVersion extends RelayProtocolVersion> =
  RelayProtocolRegistryMap[TVersion]["requestMethodDispositions"][keyof RelayProtocolRegistryMap[TVersion]["requestMethodDispositions"]];

export function getRelayProtocolRegistry<TVersion extends RelayProtocolVersion>(
  version: TVersion,
): RelayProtocolRegistryMap[TVersion] {
  return RELAY_PROTOCOL_REGISTRY[version];
}

export function parseRelayMessageForVersion<TVersion extends RelayProtocolVersion>(
  version: TVersion,
  value: unknown,
): RelayMessageForVersion<TVersion> {
  return getRelayProtocolRegistry(version).messageSchema.parse(
    value,
  ) as RelayMessageForVersion<TVersion>;
}

export function isRelayRequestMethodForVersion<TVersion extends RelayProtocolVersion>(
  version: TVersion,
  value: string,
): value is RelayRequestMethodForVersion<TVersion> {
  return Object.hasOwn(getRelayProtocolRegistry(version).requestMethodSchemas, value);
}

export function getRelayRequestMethodDispositionForVersion<TVersion extends RelayProtocolVersion>(
  version: TVersion,
  value: string,
): RelayRequestMethodDispositionForVersion<TVersion> | undefined {
  if (!isRelayRequestMethodForVersion(version, value)) {
    return undefined;
  }
  const dispositions: Readonly<Record<string, "query" | "mutation" | "local-only">> =
    getRelayProtocolRegistry(version).requestMethodDispositions;
  return dispositions[value] as RelayRequestMethodDispositionForVersion<TVersion> | undefined;
}

export function parseRelayRequestParamsForVersion<
  TVersion extends RelayProtocolVersion,
  TMethod extends RelayRequestMethodForVersion<TVersion>,
>(
  version: TVersion,
  method: TMethod,
  value: unknown,
): RelayRequestParamsForVersion<TVersion, TMethod> {
  const definitions: Readonly<
    Record<string, { readonly params: z.ZodType; readonly result: z.ZodType }>
  > = getRelayProtocolRegistry(version).requestMethodSchemas;
  const definition = definitions[method];
  if (definition === undefined) {
    throw new Error(`Relay request method ${method} is unavailable in Wire ${version}`);
  }
  return definition.params.parse(value) as RelayRequestParamsForVersion<TVersion, TMethod>;
}

export function parseRelayRequestResultForVersion<
  TVersion extends RelayProtocolVersion,
  TMethod extends RelayRequestMethodForVersion<TVersion>,
>(
  version: TVersion,
  method: TMethod,
  value: unknown,
): RelayRequestResultForVersion<TVersion, TMethod> {
  const definitions: Readonly<
    Record<string, { readonly params: z.ZodType; readonly result: z.ZodType }>
  > = getRelayProtocolRegistry(version).requestMethodSchemas;
  const definition = definitions[method];
  if (definition === undefined) {
    throw new Error(`Relay request method ${method} is unavailable in Wire ${version}`);
  }
  return definition.result.parse(value) as RelayRequestResultForVersion<TVersion, TMethod>;
}

export function parseRelayInteractionCandidateForRequestV11(
  request: RelayInteractionRequestV11,
  candidate: unknown,
): RelayInteractionCandidateParamsV11 {
  const base = {
    interactionId: request.interactionId,
    threadId: request.threadId,
    turnId: request.turnId,
  } as const;
  if (request.method === RELAY_INTERACTION_METHODS_V11.approvalRequest) {
    return relayInteractionCandidateParamsSchemaV11.parse({
      ...base,
      method: request.method,
      candidate: approvalRequestResultSchema.parse(candidate),
    });
  }
  const normalized = normalizeUserInputResult(
    {
      interactionId: request.interactionId,
      threadId: request.threadId,
      turnId: request.turnId,
      expiresAt: request.expiresAt,
      sensitivity: request.sensitivity,
      ...request.projection,
    },
    candidate,
  );
  return relayInteractionCandidateParamsSchemaV11.parse({
    ...base,
    method: request.method,
    candidate: normalized,
  });
}

export function negotiateRelayProtocolVersion(
  peerVersions: readonly string[],
): RelayProtocolVersion | undefined {
  return SUPPORTED_RELAY_PROTOCOL_VERSIONS.find((version) => peerVersions.includes(version));
}

export function canonicalizeRelayJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeRelayJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeRelayJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Relay canonical JSON received a non-JSON value");
  }
  return encoded;
}

export const RELAY_REQUEST_REPLAY_DISPOSITIONS = {
  new: "new",
  replay: "replay",
  conflict: "conflict",
} as const;

export type RelayRequestReplayDisposition =
  (typeof RELAY_REQUEST_REPLAY_DISPOSITIONS)[keyof typeof RELAY_REQUEST_REPLAY_DISPOSITIONS];

export type RelayRequestReplayClassification =
  | {
      readonly disposition:
        | typeof RELAY_REQUEST_REPLAY_DISPOSITIONS.new
        | typeof RELAY_REQUEST_REPLAY_DISPOSITIONS.replay;
    }
  | {
      readonly disposition: typeof RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict;
      readonly errorCode: typeof RELAY_ERROR_CODES.requestIdConflict;
    };

export interface RelayReplayableRuntimeRequest {
  readonly requestId: RelayRequestId;
  readonly workspaceId: WorkspaceId;
  readonly method: string;
  readonly params: JsonValue;
}

export function classifyRelayRequestReplay(
  existing: RelayReplayableRuntimeRequest,
  candidate: RelayReplayableRuntimeRequest,
): RelayRequestReplayClassification {
  if (
    existing.workspaceId !== candidate.workspaceId ||
    existing.requestId !== candidate.requestId
  ) {
    return { disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.new };
  }
  const existingIdentity: JsonValue = {
    method: existing.method,
    params: existing.params,
  };
  const candidateIdentity: JsonValue = {
    method: candidate.method,
    params: candidate.params,
  };
  if (canonicalizeRelayJson(existingIdentity) === canonicalizeRelayJson(candidateIdentity)) {
    return { disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.replay };
  }
  return {
    disposition: RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict,
    errorCode: RELAY_ERROR_CODES.requestIdConflict,
  };
}

export interface RelayAckState {
  readonly acknowledgedThrough: number;
  /** Highest sequence the caller has proved was delivered without a preceding send hole. */
  readonly advertisedThrough: number;
  readonly incomingThrough: number;
}

export type RelayAckDisposition = "advance" | "duplicate" | "invalid";

export function classifyRelayAck(state: RelayAckState): RelayAckDisposition {
  if (
    !Number.isInteger(state.acknowledgedThrough) ||
    !Number.isInteger(state.advertisedThrough) ||
    !Number.isInteger(state.incomingThrough) ||
    state.acknowledgedThrough < -1 ||
    state.advertisedThrough < -1 ||
    state.incomingThrough < -1 ||
    state.incomingThrough > state.advertisedThrough
  ) {
    return "invalid";
  }
  return state.incomingThrough > state.acknowledgedThrough ? "advance" : "duplicate";
}

export type DeviceId = z.infer<typeof deviceIdSchema>;
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type RelayRequestId = z.infer<typeof relayRequestIdSchema>;
export type RelayEnvelopeId = z.infer<typeof relayEnvelopeIdSchema>;
export type InteractionId = z.output<typeof relayInteractionIdSchema>;
export type RelayApprovalCandidateInput = z.input<typeof relayApprovalCandidateParamsSchema>;
export type RelayApprovalCandidateParams = z.infer<typeof relayApprovalCandidateParamsSchema>;
export type RelayApprovalCandidateResult = z.infer<typeof relayApprovalCandidateResultSchema>;
export type RelayError = z.infer<typeof relayErrorSchema>;
export type RelayInteractionMethodV11 = (typeof RELAY_INTERACTION_METHOD_VALUES_V11)[number];
export type RelayApprovalInteractionProjectionV11 = z.output<
  typeof relayApprovalInteractionProjectionSchemaV11
>;
export type RelayUserInputInteractionProjectionV11 = z.output<
  typeof relayUserInputInteractionProjectionSchemaV11
>;
export type RelayInteractionCandidateParamsV11 = z.output<
  typeof relayInteractionCandidateParamsSchemaV11
>;
export type RelayInteractionCandidateResultV11 = z.output<
  typeof relayInteractionCandidateResultSchemaV11
>;
export type RelayInteractionRequestV11 = z.output<typeof relayInteractionRequestSchemaV11>;
export type RelayInteractionResolvedV11 = z.output<typeof relayInteractionResolvedSchemaV11>;
export type RelayInteractionCancelledV11 = z.output<typeof relayInteractionCancelledSchemaV11>;
export type RelayTimelineEventV11 = z.output<typeof relayTimelineEventSchemaV11>;
export type RelayRuntimeEventEnvelopeV11 = z.output<typeof relayRuntimeEventEnvelopeSchemaV11>;
export type RelayMessageV10 = z.output<typeof relayMessageSchemaV10>;
export type RelayMessageV11 = z.output<typeof relayMessageSchemaV11>;
export type RelayRuntimeRequestV10 = z.output<typeof relayRuntimeRequestSchemaV10>;
export type RelayRuntimeRequestV11 = z.output<typeof relayRuntimeRequestSchemaV11>;
export type RelayRuntimeEventV10 = z.output<typeof relayRuntimeEventSchemaV10>;
export type RelayRuntimeEventV11 = z.output<typeof relayRuntimeEventSchemaV11>;
export type RelayEncryptedMessageV10 = z.output<typeof relayEncryptedMessageSchemaV10>;
export type RelayEncryptedMessageV11 = z.output<typeof relayEncryptedMessageSchemaV11>;
/** @deprecated Legacy generic Relay types remain pinned to Wire 1.0. */
export type RelayMessage = z.infer<typeof relayMessageSchema>;
/** @deprecated Legacy generic Relay types remain pinned to Wire 1.0. */
export type RelayRuntimeRequest = z.infer<typeof relayRuntimeRequestSchema>;
/** @deprecated Legacy generic Relay types remain pinned to Wire 1.0. */
export type RelayRuntimeResponse = z.infer<typeof relayRuntimeResponseSchema>;
/** @deprecated Legacy generic Relay types remain pinned to Wire 1.0. */
export type RelayRuntimeEvent = z.infer<typeof relayRuntimeEventSchema>;
export type RelayGap = z.infer<typeof relayGapSchema>;
/** @deprecated Legacy generic Relay types remain pinned to Wire 1.0. */
export type RelayEncryptedMessage = z.infer<typeof relayEncryptedMessageSchema>;
