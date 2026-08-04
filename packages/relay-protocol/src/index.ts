import {
  approvalIdSchema,
  jsonValueSchema,
  runtimeEventEnvelopeV11Schema,
  runtimeMethodSchemasV11,
  threadIdSchema,
  turnIdSchema,
  type JsonValue,
} from "@roll-agent/protocol";
import { z } from "zod/v4";

export const SUPPORTED_RELAY_PROTOCOL_VERSIONS = ["1.0"] as const;
export type RelayProtocolVersion = (typeof SUPPORTED_RELAY_PROTOCOL_VERSIONS)[number];
export const RELAY_PROTOCOL_VERSION = SUPPORTED_RELAY_PROTOCOL_VERSIONS[0];

/** @deprecated Use `RELAY_PROTOCOL_VERSION`. */
export const COMPANION_RELAY_PROTOCOL_VERSION = RELAY_PROTOCOL_VERSION;

export const RELAY_MESSAGE_TYPES = {
  deviceConnect: "device.connect",
  runtimeRequest: "runtime.request",
  runtimeResponse: "runtime.response",
  runtimeEvent: "runtime.event",
  runtimeAck: "runtime.ack",
  runtimeGap: "runtime.gap",
  runtimeEncrypted: "runtime.encrypted",
} as const;

export const RELAY_MESSAGE_TYPE_VALUES = [
  RELAY_MESSAGE_TYPES.deviceConnect,
  RELAY_MESSAGE_TYPES.runtimeRequest,
  RELAY_MESSAGE_TYPES.runtimeResponse,
  RELAY_MESSAGE_TYPES.runtimeEvent,
  RELAY_MESSAGE_TYPES.runtimeAck,
  RELAY_MESSAGE_TYPES.runtimeGap,
  RELAY_MESSAGE_TYPES.runtimeEncrypted,
] as const;

/**
 * Relay Wire 1.0 is intentionally independent from the latest Runtime registry.
 * New Runtime methods never become remotely callable without a Relay version change.
 */
export const RELAY_REQUEST_METHODS = {
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

export type RelayRequestMethod = (typeof RELAY_REQUEST_METHODS)[keyof typeof RELAY_REQUEST_METHODS];

export const RELAY_REQUEST_METHOD_VALUES = [
  RELAY_REQUEST_METHODS.initialize,
  RELAY_REQUEST_METHODS.threadList,
  RELAY_REQUEST_METHODS.threadCreate,
  RELAY_REQUEST_METHODS.threadOpen,
  RELAY_REQUEST_METHODS.threadSnapshot,
  RELAY_REQUEST_METHODS.threadRename,
  RELAY_REQUEST_METHODS.threadDelete,
  RELAY_REQUEST_METHODS.threadDetach,
  RELAY_REQUEST_METHODS.threadCapabilities,
  RELAY_REQUEST_METHODS.turnStart,
  RELAY_REQUEST_METHODS.turnCancel,
  RELAY_REQUEST_METHODS.approvalRespond,
  RELAY_REQUEST_METHODS.operationGet,
  RELAY_REQUEST_METHODS.approvalCandidate,
] as const satisfies readonly RelayRequestMethod[];

export const RELAY_REQUEST_METHOD_DISPOSITIONS = {
  [RELAY_REQUEST_METHODS.initialize]: "local-only",
  [RELAY_REQUEST_METHODS.threadList]: "query",
  [RELAY_REQUEST_METHODS.threadCreate]: "mutation",
  [RELAY_REQUEST_METHODS.threadOpen]: "query",
  [RELAY_REQUEST_METHODS.threadSnapshot]: "query",
  [RELAY_REQUEST_METHODS.threadRename]: "mutation",
  [RELAY_REQUEST_METHODS.threadDelete]: "mutation",
  [RELAY_REQUEST_METHODS.threadDetach]: "mutation",
  [RELAY_REQUEST_METHODS.threadCapabilities]: "query",
  [RELAY_REQUEST_METHODS.turnStart]: "mutation",
  [RELAY_REQUEST_METHODS.turnCancel]: "mutation",
  [RELAY_REQUEST_METHODS.approvalRespond]: "mutation",
  [RELAY_REQUEST_METHODS.operationGet]: "query",
  [RELAY_REQUEST_METHODS.approvalCandidate]: "mutation",
} as const satisfies Readonly<Record<RelayRequestMethod, "query" | "mutation" | "local-only">>;

export type RelayRequestMethodDisposition =
  (typeof RELAY_REQUEST_METHOD_DISPOSITIONS)[RelayRequestMethod];

export const RELAY_MUTATION_REQUEST_METHODS = [
  RELAY_REQUEST_METHODS.threadCreate,
  RELAY_REQUEST_METHODS.threadRename,
  RELAY_REQUEST_METHODS.threadDelete,
  RELAY_REQUEST_METHODS.threadDetach,
  RELAY_REQUEST_METHODS.turnStart,
  RELAY_REQUEST_METHODS.turnCancel,
  RELAY_REQUEST_METHODS.approvalRespond,
  RELAY_REQUEST_METHODS.approvalCandidate,
] as const satisfies readonly RelayRequestMethod[];

export const RELAY_LOCAL_ONLY_REQUEST_METHODS = [
  RELAY_REQUEST_METHODS.initialize,
] as const satisfies readonly RelayRequestMethod[];

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

export const relayRequestMethodSchemas = {
  [RELAY_REQUEST_METHODS.initialize]: runtimeMethodSchemasV11["initialize"],
  [RELAY_REQUEST_METHODS.threadList]: runtimeMethodSchemasV11["thread.list"],
  [RELAY_REQUEST_METHODS.threadCreate]: runtimeMethodSchemasV11["thread.create"],
  [RELAY_REQUEST_METHODS.threadOpen]: runtimeMethodSchemasV11["thread.open"],
  [RELAY_REQUEST_METHODS.threadSnapshot]: runtimeMethodSchemasV11["thread.snapshot"],
  [RELAY_REQUEST_METHODS.threadRename]: runtimeMethodSchemasV11["thread.rename"],
  [RELAY_REQUEST_METHODS.threadDelete]: runtimeMethodSchemasV11["thread.delete"],
  [RELAY_REQUEST_METHODS.threadDetach]: runtimeMethodSchemasV11["thread.detach"],
  [RELAY_REQUEST_METHODS.threadCapabilities]: runtimeMethodSchemasV11["thread.capabilities"],
  [RELAY_REQUEST_METHODS.turnStart]: runtimeMethodSchemasV11["turn.start"],
  [RELAY_REQUEST_METHODS.turnCancel]: runtimeMethodSchemasV11["turn.cancel"],
  [RELAY_REQUEST_METHODS.approvalRespond]: runtimeMethodSchemasV11["approval.respond"],
  [RELAY_REQUEST_METHODS.operationGet]: runtimeMethodSchemasV11["operation.get"],
  [RELAY_REQUEST_METHODS.approvalCandidate]: {
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

export const relayMessageSchemas = {
  [RELAY_MESSAGE_TYPES.deviceConnect]: relayDeviceConnectSchema,
  [RELAY_MESSAGE_TYPES.runtimeRequest]: relayRuntimeRequestSchema,
  [RELAY_MESSAGE_TYPES.runtimeResponse]: relayRuntimeResponseSchema,
  [RELAY_MESSAGE_TYPES.runtimeEvent]: relayRuntimeEventSchema,
  [RELAY_MESSAGE_TYPES.runtimeAck]: relayAckSchema,
  [RELAY_MESSAGE_TYPES.runtimeGap]: relayGapSchema,
  [RELAY_MESSAGE_TYPES.runtimeEncrypted]: relayEncryptedMessageSchema,
} as const;

export const relayMessageSchema = z.discriminatedUnion("type", [
  relayDeviceConnectSchema,
  relayRuntimeRequestSchema,
  relayRuntimeResponseSchema,
  relayRuntimeEventSchema,
  relayAckSchema,
  relayGapSchema,
  relayEncryptedMessageSchema,
]);

export interface RelayProtocolRegistry {
  readonly messageTypes: readonly (typeof RELAY_MESSAGE_TYPE_VALUES)[number][];
  readonly requestMethods: readonly RelayRequestMethod[];
  readonly mutationMethods: readonly RelayRequestMethod[];
  readonly localOnlyMethods: readonly RelayRequestMethod[];
}

export const RELAY_PROTOCOL_REGISTRY = {
  "1.0": {
    messageTypes: RELAY_MESSAGE_TYPE_VALUES,
    requestMethods: RELAY_REQUEST_METHOD_VALUES,
    mutationMethods: RELAY_MUTATION_REQUEST_METHODS,
    localOnlyMethods: RELAY_LOCAL_ONLY_REQUEST_METHODS,
  },
} as const satisfies Readonly<Record<RelayProtocolVersion, RelayProtocolRegistry>>;

export function getRelayProtocolRegistry(version: RelayProtocolVersion): RelayProtocolRegistry {
  return RELAY_PROTOCOL_REGISTRY[version];
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

export function classifyRelayRequestReplay(
  existing: RelayRuntimeRequest,
  candidate: RelayRuntimeRequest,
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
export type RelayApprovalCandidateInput = z.input<typeof relayApprovalCandidateParamsSchema>;
export type RelayApprovalCandidateParams = z.infer<typeof relayApprovalCandidateParamsSchema>;
export type RelayApprovalCandidateResult = z.infer<typeof relayApprovalCandidateResultSchema>;
export type RelayError = z.infer<typeof relayErrorSchema>;
export type RelayMessage = z.infer<typeof relayMessageSchema>;
export type RelayRuntimeRequest = z.infer<typeof relayRuntimeRequestSchema>;
export type RelayRuntimeResponse = z.infer<typeof relayRuntimeResponseSchema>;
export type RelayRuntimeEvent = z.infer<typeof relayRuntimeEventSchema>;
export type RelayGap = z.infer<typeof relayGapSchema>;
export type RelayEncryptedMessage = z.infer<typeof relayEncryptedMessageSchema>;
