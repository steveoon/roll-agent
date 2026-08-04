import { z } from "zod/v4";

export const SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11 = ["1.1", "1.0"] as const;
export const SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V12 = [
  "1.2",
  ...SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11,
] as const;
export const SUPPORTED_RUNTIME_PROTOCOL_VERSIONS = [
  "1.3",
  ...SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V12,
] as const;
export type RuntimeProtocolVersion = (typeof SUPPORTED_RUNTIME_PROTOCOL_VERSIONS)[number];
export const RUNTIME_PROTOCOL_VERSION = SUPPORTED_RUNTIME_PROTOCOL_VERSIONS[0];
export const RUNTIME_EVENT_NOTIFICATION = "runtime.event" as const;
export const RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION = "runtime.serverRequest.cancel" as const;
export const RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES = 16 * 1_024 * 1_024;
export const RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS = 10_000;
/**
 * Advertising Protocol 1.3 is a declaration that the Client accepts at least this many bytes in
 * one Runtime-to-Client NDJSON frame. The margin above the durable record limit covers the bounded
 * Runtime envelope and JSON-RPC notification metadata.
 */
export const RUNTIME_V13_MIN_CLIENT_FRAME_BYTES =
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES + 1 * 1_024 * 1_024;
/** Default bounded window for a complete retained replay batch plus per-envelope metadata. */
export const RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES = 32 * 1_024 * 1_024;
/** Recovery Snapshot metadata is clipped because the projection must always fit one Client frame. */
export const RUNTIME_V13_RECOVERY_SNAPSHOT_METADATA_MAX_CHARS = 1_024;
export const RUNTIME_V13_RECOVERY_SNAPSHOT_TIMESTAMP_MAX_CHARS = 64;
export const APPROVAL_EXPLANATION_PREVIEW_KEY = "explanation" as const;
export const APPROVAL_EXPLANATION_MAX_CHARS = 100;
export const CLIENT_CAPABILITY_METHOD_MAX_COUNT = 64;
export const CLIENT_CAPABILITY_METHOD_MAX_CHARS = 100;
export const USER_INPUT_CONTROL_MAX_COUNT = 16;
export const USER_INPUT_CONTROL_ID_MAX_CHARS = 64;
export const USER_INPUT_LABEL_MAX_CHARS = 200;
export const USER_INPUT_DESCRIPTION_MAX_CHARS = 500;
export const USER_INPUT_CHOICE_OPTION_MAX_COUNT = 50;
export const USER_INPUT_TEXT_MAX_CHARS = 10_000;
export const USER_INPUT_CANCEL_REASON_MAX_CHARS = 500;

export const INTERACTION_SENSITIVITIES = ["normal"] as const;

export const RUNTIME_SERVER_REQUEST_METHODS = {
  approvalRequest: "approval.request",
  userInputRequest: "userInput.request",
} as const;

/** Protocol 1.1 Server Request registry. Keep this list frozen. */
export const RUNTIME_SERVER_REQUEST_METHOD_VALUES_V11 = [
  RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
] as const;

export const RUNTIME_SERVER_REQUEST_METHOD_VALUES = [
  ...RUNTIME_SERVER_REQUEST_METHOD_VALUES_V11,
  RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
] as const;

export const USER_INPUT_CONTROL_TYPES = {
  text: "text",
  multiline: "multiline",
  number: "number",
  boolean: "boolean",
  choice: "choice",
} as const;

export type RuntimeServerRequestMethod =
  (typeof RUNTIME_SERVER_REQUEST_METHODS)[keyof typeof RUNTIME_SERVER_REQUEST_METHODS];

export interface RuntimeProtocolCapabilities {
  readonly serverRequests: boolean;
  readonly serverRequestCapabilityNegotiation: boolean;
  readonly approvalResolvedEvents: boolean;
  readonly clientApprovalResponses: boolean;
  readonly requiredServerRequestMethods: readonly RuntimeServerRequestMethod[];
}

export const RUNTIME_PROTOCOL_CAPABILITIES = {
  "1.2": {
    serverRequests: true,
    serverRequestCapabilityNegotiation: true,
    approvalResolvedEvents: true,
    clientApprovalResponses: false,
    requiredServerRequestMethods: [],
  },
  "1.3": {
    serverRequests: true,
    serverRequestCapabilityNegotiation: true,
    approvalResolvedEvents: true,
    clientApprovalResponses: false,
    requiredServerRequestMethods: [],
  },
  "1.1": {
    serverRequests: true,
    serverRequestCapabilityNegotiation: false,
    approvalResolvedEvents: true,
    clientApprovalResponses: false,
    requiredServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  },
  "1.0": {
    serverRequests: false,
    serverRequestCapabilityNegotiation: false,
    approvalResolvedEvents: false,
    clientApprovalResponses: true,
    requiredServerRequestMethods: [],
  },
} as const satisfies Readonly<Record<RuntimeProtocolVersion, RuntimeProtocolCapabilities>>;

export const REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION = {
  "1.3": RUNTIME_PROTOCOL_CAPABILITIES["1.3"].requiredServerRequestMethods,
  "1.2": RUNTIME_PROTOCOL_CAPABILITIES["1.2"].requiredServerRequestMethods,
  "1.1": RUNTIME_PROTOCOL_CAPABILITIES["1.1"].requiredServerRequestMethods,
  "1.0": RUNTIME_PROTOCOL_CAPABILITIES["1.0"].requiredServerRequestMethods,
} as const;

export function getRuntimeProtocolCapabilities(
  version: RuntimeProtocolVersion,
): RuntimeProtocolCapabilities {
  return RUNTIME_PROTOCOL_CAPABILITIES[version];
}

export function isRuntimeServerRequestMethodRequired(
  version: RuntimeProtocolVersion,
  method: RuntimeServerRequestMethod,
): boolean {
  return getRuntimeProtocolCapabilities(version).requiredServerRequestMethods.some(
    (requiredMethod) => requiredMethod === method,
  );
}

export const RUNTIME_METHODS = {
  initialize: "initialize",
  clientCapabilitiesSet: "client.capabilities.set",
  threadList: "thread.list",
  threadCreate: "thread.create",
  threadOpen: "thread.open",
  threadSnapshot: "thread.snapshot",
  runtimeEventsResume: "runtime.events.resume",
  threadRename: "thread.rename",
  threadDelete: "thread.delete",
  threadDetach: "thread.detach",
  threadCapabilities: "thread.capabilities",
  turnStart: "turn.start",
  turnCancel: "turn.cancel",
  approvalRespond: "approval.respond",
  operationGet: "operation.get",
} as const;

export const RUNTIME_FEATURES = [
  "thread-management",
  "snapshots",
  "turns",
  "approvals",
  "tool-streaming",
  "reasoning-summary",
  "operation-projection",
  "process-local-sequence",
] as const;

export const RUNTIME_ERROR_CODES_V11 = {
  protocolVersionUnsupported: "PROTOCOL_VERSION_UNSUPPORTED",
  initializeRequired: "INITIALIZE_REQUIRED",
  invalidParams: "INVALID_PARAMS",
  threadNotFound: "THREAD_NOT_FOUND",
  threadBusy: "THREAD_BUSY",
  turnNotFound: "TURN_NOT_FOUND",
  turnAlreadyActive: "TURN_ALREADY_ACTIVE",
  approvalNotFound: "APPROVAL_NOT_FOUND",
  capabilityUnavailable: "CAPABILITY_UNAVAILABLE",
  runtimeClosing: "RUNTIME_CLOSING",
  outcomeUnknown: "OUTCOME_UNKNOWN",
  internalError: "INTERNAL_ERROR",
} as const;

/** Runtime Protocol 1.2 error registry. Keep this object frozen. */
export const RUNTIME_ERROR_CODES_V12 = {
  ...RUNTIME_ERROR_CODES_V11,
  capabilityRevisionConflict: "CAPABILITY_REVISION_CONFLICT",
} as const;

export const RUNTIME_ERROR_CODES = {
  ...RUNTIME_ERROR_CODES_V12,
  eventCursorExpired: "EVENT_CURSOR_EXPIRED",
  eventCursorGap: "EVENT_CURSOR_GAP",
} as const;

export const RUNTIME_ERROR_CODES_V13 = RUNTIME_ERROR_CODES;

export const TOOL_OUTCOME_KINDS = [
  "success",
  "user_rejected",
  "policy_denied",
  "invalid_input",
  "cancelled",
  "tool_failed",
] as const;

export const threadIdSchema = z.string().uuid().brand<"ThreadId">();
export const turnIdSchema = z.string().uuid().brand<"TurnId">();
export const approvalIdSchema = z.string().uuid().brand<"ApprovalId">();
export const interactionIdSchema = z.string().uuid().brand<"InteractionId">();
export const runtimeInstanceIdSchema = z.string().uuid().brand<"RuntimeInstanceId">();
export const requestIdSchema = z.string().uuid().brand<"RequestId">();
export const streamIdSchema = z.string().uuid().brand<"StreamId">();
export const operationIdSchema = z.string().uuid().brand<"OperationId">();
export const runtimeEventIdSchema = z.string().uuid().brand<"RuntimeEventId">();
export const runtimeEventCursorSchema = z
  .string()
  .max(128)
  .regex(
    /^rte1:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:(?:0|[1-9]\d*):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u,
  )
  .brand<"RuntimeEventCursor">();
export const timestampSchema = z.string().datetime({ offset: true });
export const jsonValueSchema = z.json();
export const jsonRpcIdSchema = z.union([z.string(), z.number()]);
export const runtimeProtocolVersionSchema = z.enum(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS);
export const runtimeProtocolVersionV12Schema = z.enum(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V12);
export const runtimeProtocolVersionV11Schema = z.enum(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11);
export const interactionSensitivitySchema = z.enum(INTERACTION_SENSITIVITIES);
const runtimeInteractionMetadataObjectSchema = z
  .object({
    interactionId: interactionIdSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    expiresAt: timestampSchema,
    sensitivity: interactionSensitivitySchema,
  })
  .strict();
export const runtimeInteractionMetadataSchema = runtimeInteractionMetadataObjectSchema.readonly();
export const approvalExplanationSchema = z
  .string()
  .trim()
  .min(1)
  .max(APPROVAL_EXPLANATION_MAX_CHARS);

export type ThreadId = z.infer<typeof threadIdSchema>;
export type TurnId = z.infer<typeof turnIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type InteractionId = z.infer<typeof interactionIdSchema>;
export type RuntimeInstanceId = z.infer<typeof runtimeInstanceIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type StreamId = z.infer<typeof streamIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type RuntimeEventId = z.infer<typeof runtimeEventIdSchema>;
export type RuntimeEventCursor = z.infer<typeof runtimeEventCursorSchema>;
export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export type InteractionSensitivity = z.infer<typeof interactionSensitivitySchema>;

type RuntimeEventCursorParts = {
  readonly eventLogId: string;
  readonly threadSequence: bigint;
  readonly eventId: RuntimeEventId;
};

function runtimeEventCursorParts(cursor: RuntimeEventCursor): RuntimeEventCursorParts {
  const parsed = runtimeEventCursorSchema.parse(cursor);
  const [, eventLogId, threadSequence, eventId] = parsed.split(":");
  if (eventLogId === undefined || threadSequence === undefined || eventId === undefined) {
    throw new Error("Runtime Event cursor has an invalid shape");
  }
  return {
    eventLogId,
    threadSequence: BigInt(threadSequence),
    eventId: runtimeEventIdSchema.parse(eventId),
  };
}

function assertComparableRuntimeEventCursors(
  left: RuntimeEventCursorParts,
  right: RuntimeEventCursorParts,
): void {
  if (left.eventLogId !== right.eventLogId) {
    throw new Error("Runtime Event cursors belong to different event logs");
  }
  if (left.threadSequence === right.threadSequence && left.eventId !== right.eventId) {
    throw new Error("Runtime Event cursors conflict at the same Thread sequence");
  }
}

/** Compares opaque cursors from one Thread event log without exposing their encoded fields. */
export function compareRuntimeEventCursors(
  left: RuntimeEventCursor | null,
  right: RuntimeEventCursor | null,
): -1 | 0 | 1 {
  if (left === null) {
    return right === null ? 0 : -1;
  }
  if (right === null) {
    return 1;
  }
  const leftParts = runtimeEventCursorParts(left);
  const rightParts = runtimeEventCursorParts(right);
  assertComparableRuntimeEventCursors(leftParts, rightParts);
  if (leftParts.threadSequence < rightParts.threadSequence) {
    return -1;
  }
  if (leftParts.threadSequence > rightParts.threadSequence) {
    return 1;
  }
  return 0;
}

/** Returns the signed step distance, treating `null` as the checkpoint before sequence zero. */
export function runtimeEventCursorDistance(
  from: RuntimeEventCursor | null,
  to: RuntimeEventCursor | null,
): bigint {
  if (from === null) {
    if (to === null) {
      return 0n;
    }
    return runtimeEventCursorParts(to).threadSequence + 1n;
  }
  if (to === null) {
    return -(runtimeEventCursorParts(from).threadSequence + 1n);
  }
  const fromParts = runtimeEventCursorParts(from);
  const toParts = runtimeEventCursorParts(to);
  assertComparableRuntimeEventCursors(fromParts, toParts);
  return toParts.threadSequence - fromParts.threadSequence;
}

const runtimeClientInfoFields = {
  name: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(100),
} as const;

export const runtimeClientInfoSchema = z.object(runtimeClientInfoFields).strict().readonly();

export const runtimeServerInfoSchema = z
  .object({
    ...runtimeClientInfoFields,
    runtimeVersion: z.string().trim().min(1).max(100),
  })
  .strict()
  .readonly();

/** Runtime Protocol 1.2/1.1/1.0 limits. Keep this schema frozen. */
export const runtimeLimitsV12Schema = z
  .object({
    maxFrameBytes: z.number().int().positive(),
    maxPageSize: z.number().int().positive(),
    eventReplay: z.literal(false),
    idempotencyCacheEntries: z.number().int().positive(),
  })
  .strict()
  .readonly();

export const runtimeLimitsV13Schema = z
  .object({
    maxFrameBytes: z.number().int().positive(),
    maxPageSize: z.number().int().positive(),
    eventReplay: z.literal(true),
    idempotencyCacheEntries: z.number().int().positive(),
  })
  .strict()
  .readonly();

export const runtimeLimitsSchema = z.union([runtimeLimitsV13Schema, runtimeLimitsV12Schema]);

export const initializeParamsSchema = z
  .object({
    protocolVersions: z.array(z.string().min(1)).min(1),
    client: runtimeClientInfoSchema,
  })
  .strict()
  .readonly();

const initializeResultCommonFields = {
  runtimeInstanceId: runtimeInstanceIdSchema,
  server: runtimeServerInfoSchema,
  features: z.array(z.enum(RUNTIME_FEATURES)),
} as const;

/** Runtime Protocol 1.1/1.0 initialize result. Keep this schema frozen. */
export const initializeResultV11Schema = z
  .object({
    protocolVersion: runtimeProtocolVersionV11Schema,
    ...initializeResultCommonFields,
    limits: runtimeLimitsV12Schema,
  })
  .strict()
  .readonly();

/** Runtime Protocol 1.2 initialize result. */
export const initializeResultV12Schema = z
  .object({
    protocolVersion: z.literal("1.2"),
    ...initializeResultCommonFields,
    limits: runtimeLimitsV12Schema,
  })
  .strict()
  .readonly();

export const initializeResultV13Schema = z
  .object({
    protocolVersion: z.literal("1.3"),
    ...initializeResultCommonFields,
    limits: runtimeLimitsV13Schema,
  })
  .strict()
  .readonly();

/** Any currently supported Runtime Protocol initialize result. */
export const initializeResultSchema = z.union([
  initializeResultV13Schema,
  initializeResultV12Schema,
  initializeResultV11Schema,
]);

const clientCapabilityMethodNameSchema = z.string().min(1).max(CLIENT_CAPABILITY_METHOD_MAX_CHARS);

const clientCapabilityMethodNamesSchema = z
  .array(clientCapabilityMethodNameSchema)
  .max(CLIENT_CAPABILITY_METHOD_MAX_COUNT)
  .superRefine((methods, context) => {
    const seen = new Set<string>();
    for (const [index, method] of methods.entries()) {
      if (seen.has(method)) {
        context.addIssue({
          code: "custom",
          message: "serverRequestMethods must not contain duplicates",
          path: [index],
        });
      }
      seen.add(method);
    }
  });

const acceptedServerRequestMethodsSchema = z
  .array(z.enum(RUNTIME_SERVER_REQUEST_METHODS))
  .max(CLIENT_CAPABILITY_METHOD_MAX_COUNT)
  .superRefine((methods, context) => {
    const seen = new Set<RuntimeServerRequestMethod>();
    for (const [index, method] of methods.entries()) {
      if (seen.has(method)) {
        context.addIssue({
          code: "custom",
          message: "acceptedServerRequestMethods must not contain duplicates",
          path: [index],
        });
      }
      seen.add(method);
    }
  });

export const clientCapabilitiesSetParamsSchema = z
  .object({
    revision: z.number().int().min(1),
    serverRequestMethods: clientCapabilityMethodNamesSchema,
  })
  .strict()
  .readonly();

export const clientCapabilitiesSetResultSchema = z
  .object({
    revision: z.number().int().min(1),
    acceptedServerRequestMethods: acceptedServerRequestMethodsSchema,
  })
  .strict()
  .readonly();

export const threadSummarySchema = z
  .object({
    id: threadIdSchema,
    title: z.string().optional(),
    model: z.string().optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    messageCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const uiMessagePartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict()
  .readonly();

export const uiMessageSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant"]),
    createdAt: timestampSchema,
    parts: z.array(uiMessagePartSchema),
  })
  .strict()
  .readonly();

export const toolOutcomeSchema = z
  .object({
    kind: z.enum(TOOL_OUTCOME_KINDS),
    reason: z.string().optional(),
  })
  .strict()
  .readonly();

export const operationViewSchema = z
  .object({
    id: operationIdSchema,
    sequence: z.number().int().nonnegative(),
    toolCallId: z.string().min(1),
    agentName: z.string().min(1),
    toolName: z.string().min(1),
    createdAt: timestampSchema,
    outcome: toolOutcomeSchema,
    display: jsonValueSchema,
  })
  .strict()
  .readonly();

export const activeTurnV11Schema = z
  .object({
    id: turnIdSchema,
    status: z.enum(["running", "cancelling"]),
    startedAt: timestampSchema,
  })
  .strict()
  .readonly();

export const activeTurnV12Schema = z
  .object({
    id: turnIdSchema,
    status: z.enum(["running", "cancelling", "waiting-for-user"]),
    startedAt: timestampSchema,
  })
  .strict()
  .readonly();

/** Latest Runtime Protocol active Turn shape. */
export const activeTurnSchema = activeTurnV12Schema;

export const pendingApprovalSchema = z
  .object({
    id: approvalIdSchema,
    turnId: turnIdSchema,
    agentName: z.string().min(1),
    toolName: z.string().min(1),
    preview: jsonValueSchema,
    reason: z.string().optional(),
  })
  .strict()
  .readonly();

export const messagePageSchema = z
  .object({
    items: z.array(uiMessageSchema),
    nextBeforeSequence: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .readonly();

export const operationPageSchema = z
  .object({
    items: z.array(operationViewSchema),
    nextBeforeSequence: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .readonly();

const threadSnapshotV11Fields = {
  thread: threadSummarySchema,
  messages: messagePageSchema,
  operations: operationPageSchema,
  activeTurn: activeTurnV11Schema.optional(),
  pendingApprovals: z.array(pendingApprovalSchema),
  transcriptCompleteness: z.enum(["complete", "legacy_snapshot"]),
} as const;

/** Protocol 1.1/1.0 wire shape. Keep this schema frozen. */
export const threadSnapshotV11Schema = z.object(threadSnapshotV11Fields).strict().readonly();

const userInputIdentifierSchema = z
  .string()
  .min(1)
  .max(USER_INPUT_CONTROL_ID_MAX_CHARS)
  .refine((value) => value.trim().length > 0, { message: "identifier must not be blank" });
const userInputLabelSchema = z
  .string()
  .min(1)
  .max(USER_INPUT_LABEL_MAX_CHARS)
  .refine((value) => value.trim().length > 0, { message: "label must not be blank" });
const userInputDescriptionSchema = z.string().min(1).max(USER_INPUT_DESCRIPTION_MAX_CHARS);
const userInputLengthSchema = z.number().int().min(0).max(USER_INPUT_TEXT_MAX_CHARS);
const userInputSelectionCountSchema = z
  .number()
  .int()
  .min(0)
  .max(USER_INPUT_CHOICE_OPTION_MAX_COUNT);
const userInputControlBaseFields = {
  id: userInputIdentifierSchema,
  label: userInputLabelSchema,
  description: userInputDescriptionSchema.optional(),
  required: z.boolean(),
} as const;
const userInputTextControlFields = {
  ...userInputControlBaseFields,
  minLength: userInputLengthSchema.optional(),
  maxLength: userInputLengthSchema.optional(),
} as const;

export const userInputTextControlSchema = z
  .object({
    type: z.literal(USER_INPUT_CONTROL_TYPES.text),
    ...userInputTextControlFields,
  })
  .strict()
  .superRefine((control, context) => {
    const minimum = Math.max(control.minLength ?? 0, control.required ? 1 : 0);
    const maximum = control.maxLength ?? USER_INPUT_TEXT_MAX_CHARS;
    if (minimum > maximum) {
      context.addIssue({
        code: "custom",
        message: "effective minLength must not exceed maxLength",
        path: ["maxLength"],
      });
    }
  })
  .readonly();

export const userInputMultilineControlSchema = z
  .object({
    type: z.literal(USER_INPUT_CONTROL_TYPES.multiline),
    ...userInputTextControlFields,
  })
  .strict()
  .superRefine((control, context) => {
    const minimum = Math.max(control.minLength ?? 0, control.required ? 1 : 0);
    const maximum = control.maxLength ?? USER_INPUT_TEXT_MAX_CHARS;
    if (minimum > maximum) {
      context.addIssue({
        code: "custom",
        message: "effective minLength must not exceed maxLength",
        path: ["maxLength"],
      });
    }
  })
  .readonly();

export const userInputNumberControlSchema = z
  .object({
    type: z.literal(USER_INPUT_CONTROL_TYPES.number),
    ...userInputControlBaseFields,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    integer: z.boolean().optional(),
  })
  .strict()
  .superRefine((control, context) => {
    if (control.min !== undefined && control.max !== undefined && control.min > control.max) {
      context.addIssue({
        code: "custom",
        message: "min must not exceed max",
        path: ["min"],
      });
    }
    if (
      control.integer === true &&
      Math.ceil(control.min ?? Number.NEGATIVE_INFINITY) >
        Math.floor(control.max ?? Number.POSITIVE_INFINITY)
    ) {
      context.addIssue({
        code: "custom",
        message: "integer bounds must include at least one integer",
        path: ["integer"],
      });
    }
  })
  .readonly();

export const userInputBooleanControlSchema = z
  .object({
    type: z.literal(USER_INPUT_CONTROL_TYPES.boolean),
    ...userInputControlBaseFields,
  })
  .strict()
  .readonly();

export const userInputChoiceOptionSchema = z
  .object({
    id: userInputIdentifierSchema,
    label: userInputLabelSchema,
    description: userInputDescriptionSchema.optional(),
  })
  .strict()
  .readonly();

export const userInputChoiceControlSchema = z
  .object({
    type: z.literal(USER_INPUT_CONTROL_TYPES.choice),
    ...userInputControlBaseFields,
    multiple: z.boolean(),
    options: z.array(userInputChoiceOptionSchema).min(1).max(USER_INPUT_CHOICE_OPTION_MAX_COUNT),
    minSelections: userInputSelectionCountSchema.optional(),
    maxSelections: userInputSelectionCountSchema.min(1).optional(),
  })
  .strict()
  .superRefine((control, context) => {
    const optionIds = new Set<string>();
    for (const [index, option] of control.options.entries()) {
      if (optionIds.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: "choice option ids must be unique",
          path: ["options", index, "id"],
        });
      }
      optionIds.add(option.id);
    }
    const maximum = control.maxSelections ?? (control.multiple ? control.options.length : 1);
    if (control.minSelections !== undefined && control.minSelections > maximum) {
      context.addIssue({
        code: "custom",
        message: "minSelections must not exceed maxSelections",
        path: ["minSelections"],
      });
    }
    if (maximum > control.options.length) {
      context.addIssue({
        code: "custom",
        message: "maxSelections must not exceed the option count",
        path: ["maxSelections"],
      });
    }
    if (
      !control.multiple &&
      ((control.minSelections !== undefined && control.minSelections > 1) || maximum > 1)
    ) {
      context.addIssue({
        code: "custom",
        message: "single-choice controls allow at most one selection",
        path: [
          control.minSelections !== undefined && control.minSelections > 1
            ? "minSelections"
            : "maxSelections",
        ],
      });
    }
  })
  .readonly();

export const userInputControlSchema = z.discriminatedUnion("type", [
  userInputTextControlSchema,
  userInputMultilineControlSchema,
  userInputNumberControlSchema,
  userInputBooleanControlSchema,
  userInputChoiceControlSchema,
]);

const userInputControlsSchema = z
  .array(userInputControlSchema)
  .min(1)
  .max(USER_INPUT_CONTROL_MAX_COUNT)
  .superRefine((controls, context) => {
    const controlIds = new Set<string>();
    for (const [index, control] of controls.entries()) {
      if (controlIds.has(control.id)) {
        context.addIssue({
          code: "custom",
          message: "control ids must be unique",
          path: [index, "id"],
        });
      }
      controlIds.add(control.id);
    }
  });
const userInputFormObjectSchema = z
  .object({
    title: userInputLabelSchema.optional(),
    description: userInputDescriptionSchema.optional(),
    controls: userInputControlsSchema,
  })
  .strict();

/** Safe model-authored form definition shared by Runtime, clients and first-party UI. */
export const userInputFormSchema = userInputFormObjectSchema.readonly();

const userInputRequestParamsV12ObjectSchema = runtimeInteractionMetadataObjectSchema.extend(
  userInputFormObjectSchema.shape,
);

export const userInputRequestParamsV12Schema = userInputRequestParamsV12ObjectSchema.readonly();

export const userInputValueSchema = z.union([
  z.string().max(USER_INPUT_TEXT_MAX_CHARS),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(USER_INPUT_CONTROL_ID_MAX_CHARS)).max(USER_INPUT_CHOICE_OPTION_MAX_COUNT),
]);

export const userInputSubmittedValueSchema = z
  .object({
    id: userInputIdentifierSchema,
    value: userInputValueSchema,
  })
  .strict()
  .readonly();

export const userInputSubmittedResultSchema = z
  .object({
    status: z.literal("submitted"),
    values: z.array(userInputSubmittedValueSchema).max(USER_INPUT_CONTROL_MAX_COUNT),
  })
  .strict()
  .readonly();

export const userInputCancelledResultSchema = z
  .object({
    status: z.literal("cancelled"),
    reason: z.string().min(1).max(USER_INPUT_CANCEL_REASON_MAX_CHARS).optional(),
  })
  .strict()
  .readonly();

export const userInputResultSchema = z.discriminatedUnion("status", [
  userInputSubmittedResultSchema,
  userInputCancelledResultSchema,
]);

export const pendingApprovalInteractionProjectionSchema = z
  .object({
    method: z.literal(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest),
    interactionId: interactionIdSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    expiresAt: timestampSchema,
    sensitivity: z.literal("normal"),
    approvalId: approvalIdSchema,
  })
  .strict()
  .readonly();

export const pendingUserInputInteractionProjectionSchema = userInputRequestParamsV12ObjectSchema
  .extend({
    method: z.literal(RUNTIME_SERVER_REQUEST_METHODS.userInputRequest),
  })
  .readonly();

export const pendingInteractionProjectionSchema = z.discriminatedUnion("method", [
  pendingApprovalInteractionProjectionSchema,
  pendingUserInputInteractionProjectionSchema,
]);

const threadSnapshotV12Fields = {
  ...threadSnapshotV11Fields,
  activeTurn: activeTurnV12Schema.optional(),
  pendingInteractions: z.array(pendingInteractionProjectionSchema),
} as const;

/** Runtime Protocol 1.2 snapshot. Keep this schema frozen. */
export const threadSnapshotV12Schema = z.object(threadSnapshotV12Fields).strict().readonly();

export const threadSnapshotV13FullSchema = z
  .object({
    ...threadSnapshotV12Fields,
    eventCursor: runtimeEventCursorSchema.nullable(),
  })
  .strict()
  .readonly();

const recoveryThreadSummarySchema = z
  .object({
    id: threadIdSchema,
    title: z.string().max(RUNTIME_V13_RECOVERY_SNAPSHOT_METADATA_MAX_CHARS).optional(),
    model: z.string().max(RUNTIME_V13_RECOVERY_SNAPSHOT_METADATA_MAX_CHARS).optional(),
    createdAt: z
      .string()
      .max(RUNTIME_V13_RECOVERY_SNAPSHOT_TIMESTAMP_MAX_CHARS)
      .datetime({ offset: true }),
    updatedAt: z
      .string()
      .max(RUNTIME_V13_RECOVERY_SNAPSHOT_TIMESTAMP_MAX_CHARS)
      .datetime({ offset: true }),
    messageCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
const recoveryMessagePageSchema = z
  .object({
    items: z.array(uiMessageSchema).max(0),
    nextBeforeSequence: z.null(),
  })
  .strict()
  .readonly();
const recoveryOperationPageSchema = z
  .object({
    items: z.array(operationViewSchema).max(0),
    nextBeforeSequence: z.null(),
  })
  .strict()
  .readonly();
const recoveryActiveTurnSchema = z
  .object({
    id: turnIdSchema,
    status: z.enum(["running", "cancelling", "waiting-for-user"]),
    startedAt: z
      .string()
      .max(RUNTIME_V13_RECOVERY_SNAPSHOT_TIMESTAMP_MAX_CHARS)
      .datetime({ offset: true }),
  })
  .strict()
  .readonly();

export const threadRecoverySnapshotV13Schema = z
  .object({
    ...threadSnapshotV12Fields,
    thread: recoveryThreadSummarySchema,
    messages: recoveryMessagePageSchema,
    operations: recoveryOperationPageSchema,
    pendingApprovals: z.array(pendingApprovalSchema).max(0),
    pendingInteractions: z.array(pendingInteractionProjectionSchema).max(0),
    activeTurn: recoveryActiveTurnSchema.optional(),
    eventCursor: runtimeEventCursorSchema.nullable(),
    recoveryProjection: z.literal(true),
  })
  .strict()
  .readonly();

export const threadSnapshotV13Schema = z.union([
  threadSnapshotV13FullSchema,
  threadRecoverySnapshotV13Schema,
]);

/** Latest Runtime Protocol snapshot. Use versioned schemas for compatibility. */
export const threadSnapshotSchema = threadSnapshotV13Schema;

const pageSizeSchema = z.number().int().min(1).max(500).default(100);
const requestFields = { requestId: requestIdSchema } as const;
const threadRequestFields = { threadId: threadIdSchema } as const;

export const threadListParamsSchema = z
  .object({
    cursor: z.string().regex(/^\d+$/u).optional(),
    limit: pageSizeSchema,
  })
  .strict()
  .readonly();

export const threadListResultSchema = z
  .object({
    items: z.array(threadSummarySchema),
    nextCursor: z.string().regex(/^\d+$/u).nullable(),
  })
  .strict()
  .readonly();

export const threadCreateParamsSchema = z
  .object({
    ...requestFields,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .readonly();

export const threadCreateResultSchema = z
  .object({
    thread: threadSummarySchema,
  })
  .strict()
  .readonly();

export const threadOpenParamsSchema = z.object(threadRequestFields).strict().readonly();
export const threadOpenResultV11Schema = threadSnapshotV11Schema;
export const threadOpenResultSchema = threadSnapshotSchema;

const threadSnapshotParamFields = {
  ...threadRequestFields,
  messageBeforeSequence: z.number().int().nonnegative().optional(),
  operationBeforeSequence: z.number().int().nonnegative().optional(),
  limit: pageSizeSchema,
} as const;

/** Runtime Protocol 1.2/1.1/1.0 request shape. Keep this schema frozen. */
export const threadSnapshotParamsV12Schema = z
  .object({
    ...threadSnapshotParamFields,
  })
  .strict()
  .readonly();

export const threadSnapshotParamsV13Schema = z
  .object({
    ...threadSnapshotParamFields,
    recovery: z.literal(true).optional(),
  })
  .strict()
  .readonly();

/** Latest Runtime Protocol request shape. Use the versioned schemas for compatibility. */
export const threadSnapshotParamsSchema = threadSnapshotParamsV13Schema;

export const threadSnapshotResultV11Schema = threadSnapshotV11Schema;
export const threadSnapshotResultV12Schema = threadSnapshotV12Schema;
export const threadSnapshotResultSchema = threadSnapshotSchema;

export const runtimeEventsResumeParamsSchema = z
  .object({
    ...threadRequestFields,
    afterCursor: runtimeEventCursorSchema.nullable(),
  })
  .strict()
  .readonly();

export const runtimeEventsResumeResultSchema = z
  .object({
    throughCursor: runtimeEventCursorSchema.nullable(),
    replayedCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const threadRenameParamsSchema = z
  .object({
    ...requestFields,
    ...threadRequestFields,
    title: z.string().trim().min(1).max(200),
  })
  .strict()
  .readonly();

export const threadRenameResultSchema = z
  .object({
    thread: threadSummarySchema,
  })
  .strict()
  .readonly();

export const threadDeleteParamsSchema = z
  .object({ ...requestFields, ...threadRequestFields })
  .strict()
  .readonly();
export const threadDeleteResultSchema = z
  .object({ deleted: z.literal(true) })
  .strict()
  .readonly();
export const threadDetachParamsSchema = z
  .object({ ...requestFields, ...threadRequestFields })
  .strict()
  .readonly();
export const threadDetachResultSchema = z.object({ detached: z.boolean() }).strict().readonly();

export const threadCapabilitiesParamsSchema = z.object(threadRequestFields).strict().readonly();
export const threadCapabilitiesResultSchema = z
  .object({
    manifest: jsonValueSchema,
  })
  .strict()
  .readonly();

export const turnStartParamsSchema = z
  .object({
    ...requestFields,
    ...threadRequestFields,
    turnId: turnIdSchema,
    input: z
      .object({
        text: z.string().min(1),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const turnStartResultSchema = z
  .object({
    accepted: z.literal(true),
    turnId: turnIdSchema,
  })
  .strict()
  .readonly();

export const turnCancelParamsSchema = z
  .object({
    ...requestFields,
    ...threadRequestFields,
    turnId: turnIdSchema,
  })
  .strict()
  .readonly();

export const turnCancelResultSchema = z.object({ cancelling: z.boolean() }).strict().readonly();

const approvalRejectReasonSchema = z.string().min(1);

export const approvalRespondParamsSchema = z
  .object({
    ...requestFields,
    ...threadRequestFields,
    turnId: turnIdSchema,
    approvalId: approvalIdSchema,
    decision: z.enum(["approve", "reject"]),
    reason: approvalRejectReasonSchema.optional(),
  })
  .strict()
  .readonly();

export const approvalRespondResultSchema = z
  .object({ resolved: z.literal(true) })
  .strict()
  .readonly();

export const approvalRequestParamsSchema = z
  .object({
    threadId: threadIdSchema,
    approval: pendingApprovalSchema,
    expiresAt: timestampSchema.optional(),
  })
  .strict()
  .readonly();

/** Protocol 1.1 wire shape. Keep this alias frozen with approvalRequestParamsSchema. */
export const approvalRequestParamsV11Schema = approvalRequestParamsSchema;

export const approvalRequestParamsV12Schema = z
  .object({
    interactionId: interactionIdSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    expiresAt: timestampSchema,
    sensitivity: z.literal("normal"),
    approval: pendingApprovalSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.turnId !== value.approval.turnId) {
      context.addIssue({
        code: "custom",
        message: "approval.turnId must match interaction turnId",
        path: ["approval", "turnId"],
      });
    }
  })
  .readonly();

export const approvalRequestResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approve"),
    })
    .strict()
    .readonly(),
  z
    .object({
      decision: z.literal("reject"),
      reason: approvalRejectReasonSchema.optional(),
    })
    .strict()
    .readonly(),
]);

export const runtimeServerRequestCancelParamsSchema = z
  .object({
    serverRequestId: jsonRpcIdSchema,
    approvalId: approvalIdSchema.optional(),
    reason: z.string().min(1),
  })
  .strict()
  .readonly();

/** Protocol 1.1 wire shape. Keep this alias frozen with runtimeServerRequestCancelParamsSchema. */
export const runtimeServerRequestCancelParamsV11Schema = runtimeServerRequestCancelParamsSchema;

export const runtimeServerRequestCancelParamsV12Schema = z
  .object({
    interactionId: interactionIdSchema,
    reason: z.string().min(1),
  })
  .strict()
  .readonly();

export const runtimeServerRequestCancelProjectionInputSchema = z
  .object({
    interactionId: interactionIdSchema,
    serverRequestId: jsonRpcIdSchema,
    approvalId: approvalIdSchema.optional(),
    reason: z.string().min(1),
  })
  .strict()
  .readonly();

export const operationGetParamsSchema = z
  .object({
    ...threadRequestFields,
    operationId: operationIdSchema,
  })
  .strict()
  .readonly();

export const operationGetResultSchema = z
  .object({
    operation: operationViewSchema.nullable(),
  })
  .strict()
  .readonly();

export const approvalResolutionSchema = z.union([
  z
    .object({
      status: z.literal("resolved"),
      decision: z.literal("approve"),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("resolved"),
      decision: z.literal("reject"),
      reason: approvalRejectReasonSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("cancelled"),
      reason: z.string().min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("expired"),
      reason: z.string().min(1).optional(),
    })
    .strict()
    .readonly(),
]);

const turnStartedEventSchema = z
  .object({ type: z.literal("turn.started") })
  .strict()
  .readonly();
const messageStartedEventSchema = z
  .object({ type: z.literal("message.started"), streamId: streamIdSchema })
  .strict()
  .readonly();
const messageDeltaEventSchema = z
  .object({ type: z.literal("message.delta"), streamId: streamIdSchema, delta: z.string() })
  .strict()
  .readonly();
const messageCompletedEventSchema = z
  .object({ type: z.literal("message.completed"), streamId: streamIdSchema, text: z.string() })
  .strict()
  .readonly();
const reasoningSummaryDeltaEventSchema = z
  .object({
    type: z.literal("reasoning.summary.delta"),
    reasoningId: z.string().min(1),
    delta: z.string(),
  })
  .strict()
  .readonly();
const toolStartedEventSchema = z
  .object({
    type: z.literal("tool.started"),
    toolCallId: z.string().min(1),
    agentName: z.string().min(1),
    toolName: z.string().min(1),
    input: jsonValueSchema,
  })
  .strict()
  .readonly();
const toolOutputEventSchema = z
  .object({
    type: z.literal("tool.output"),
    toolCallId: z.string().min(1),
    agentName: z.string().min(1),
    toolName: z.string().min(1),
    stream: z.enum(["stdout", "stderr"]),
    delta: z.string(),
  })
  .strict()
  .readonly();
const toolCompletedEventSchema = z
  .object({
    type: z.literal("tool.completed"),
    toolCallId: z.string().min(1),
    agentName: z.string().min(1),
    toolName: z.string().min(1),
    operationId: operationIdSchema.optional(),
    outcome: toolOutcomeSchema.optional(),
    display: jsonValueSchema,
  })
  .strict()
  .readonly();
const approvalRequiredEventSchema = z
  .object({ type: z.literal("approval.required"), approval: pendingApprovalSchema })
  .strict()
  .readonly();
const approvalResolvedEventSchema = z
  .object({
    type: z.literal("approval.resolved"),
    approvalId: approvalIdSchema,
    resolution: approvalResolutionSchema,
  })
  .strict()
  .readonly();
const turnCompletedEventSchema = z
  .object({ type: z.literal("turn.completed") })
  .strict()
  .readonly();
const turnCancelledEventSchema = z
  .object({ type: z.literal("turn.cancelled"), reason: z.string(), message: z.string() })
  .strict()
  .readonly();
const turnFailedEventSchema = z
  .object({
    type: z.literal("turn.failed"),
    stage: z.enum(["bootstrap", "plan", "execute"]),
    message: z.string(),
  })
  .strict()
  .readonly();
const capabilitiesChangedEventSchema = z
  .object({ type: z.literal("capabilities.changed") })
  .strict()
  .readonly();

/** Runtime Protocol 1.1/1.0 event payloads. Keep this registry and ordering frozen. */
export const runtimeEventV11Schema = z.discriminatedUnion("type", [
  turnStartedEventSchema,
  messageStartedEventSchema,
  messageDeltaEventSchema,
  messageCompletedEventSchema,
  reasoningSummaryDeltaEventSchema,
  toolStartedEventSchema,
  toolOutputEventSchema,
  toolCompletedEventSchema,
  approvalRequiredEventSchema,
  approvalResolvedEventSchema,
  turnCompletedEventSchema,
  turnCancelledEventSchema,
  turnFailedEventSchema,
  capabilitiesChangedEventSchema,
]);

export const runtimeDurableEventV13Schema = z.discriminatedUnion("type", [
  turnStartedEventSchema,
  messageCompletedEventSchema,
  toolCompletedEventSchema,
  approvalRequiredEventSchema,
  approvalResolvedEventSchema,
  turnCompletedEventSchema,
  turnCancelledEventSchema,
  turnFailedEventSchema,
  capabilitiesChangedEventSchema,
]);

export const runtimeEphemeralEventV13Schema = z.discriminatedUnion("type", [
  messageStartedEventSchema,
  messageDeltaEventSchema,
  reasoningSummaryDeltaEventSchema,
  toolStartedEventSchema,
  toolOutputEventSchema,
]);

/** Runtime Protocol 1.2 event payloads. Currently identical to the 1.1 payload registry. */
export const runtimeEventV12Schema = runtimeEventV11Schema;

/** Runtime Protocol 1.3 retains the event payload registry and versions durability in the envelope. */
export const runtimeEventV13Schema = runtimeEventV12Schema;

/** Latest Runtime Protocol event payloads. */
export const runtimeEventSchema = runtimeEventV13Schema;

const runtimeEventEnvelopeFields = {
  runtimeInstanceId: runtimeInstanceIdSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: timestampSchema,
  threadId: threadIdSchema,
  turnId: turnIdSchema.optional(),
} as const;

type RuntimeEventCapabilityEnvelope = {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly event: z.infer<typeof runtimeEventSchema>;
};

function validateRuntimeEventCapabilities(
  value: RuntimeEventCapabilityEnvelope,
  context: z.RefinementCtx,
): void {
  if (
    !getRuntimeProtocolCapabilities(value.protocolVersion).approvalResolvedEvents &&
    value.event.type === "approval.resolved"
  ) {
    context.addIssue({
      code: "custom",
      message: "approval.resolved requires the negotiated approval-resolved event capability",
      path: ["event", "type"],
    });
  }
}

/** Runtime Protocol 1.1/1.0 event envelope. Keep this schema frozen. */
export const runtimeEventEnvelopeV11Schema = z
  .object({
    protocolVersion: runtimeProtocolVersionV11Schema,
    ...runtimeEventEnvelopeFields,
    event: runtimeEventV11Schema,
  })
  .strict()
  .superRefine(validateRuntimeEventCapabilities)
  .readonly();

/** Runtime Protocol 1.2 event envelope. Keep this schema frozen. */
export const runtimeEventEnvelopeV12Schema = z
  .object({
    protocolVersion: z.literal("1.2"),
    ...runtimeEventEnvelopeFields,
    event: runtimeEventV12Schema,
  })
  .strict()
  .superRefine(validateRuntimeEventCapabilities)
  .readonly();

export const runtimeDurableEventEnvelopeV13Schema = z
  .object({
    protocolVersion: z.literal("1.3"),
    ...runtimeEventEnvelopeFields,
    durability: z.literal("durable"),
    eventId: runtimeEventIdSchema,
    cursor: runtimeEventCursorSchema,
    event: runtimeDurableEventV13Schema,
  })
  .strict()
  .superRefine(validateRuntimeEventCapabilities)
  .readonly();

export const runtimeEphemeralEventEnvelopeV13Schema = z
  .object({
    protocolVersion: z.literal("1.3"),
    ...runtimeEventEnvelopeFields,
    durability: z.literal("ephemeral"),
    event: runtimeEphemeralEventV13Schema,
  })
  .strict()
  .superRefine(validateRuntimeEventCapabilities)
  .readonly();

export const runtimeEventEnvelopeV13Schema = z.discriminatedUnion("durability", [
  runtimeDurableEventEnvelopeV13Schema,
  runtimeEphemeralEventEnvelopeV13Schema,
]);

/** Any currently supported Runtime Event envelope. */
export const runtimeEventEnvelopeSchema = z.union([
  runtimeEventEnvelopeV13Schema,
  runtimeEventEnvelopeV12Schema,
  runtimeEventEnvelopeV11Schema,
]);

export const runtimeProtocolErrorDataSchema = z
  .object({
    rollCode: z.enum(Object.values(RUNTIME_ERROR_CODES_V11)),
    retryable: z.boolean(),
    details: jsonValueSchema.optional(),
  })
  .strict()
  .readonly();

/** Protocol 1.1 wire shape. Keep this alias frozen with runtimeProtocolErrorDataSchema. */
export const runtimeProtocolErrorDataV11Schema = runtimeProtocolErrorDataSchema;

export const runtimeProtocolErrorDataV12Schema = z
  .object({
    rollCode: z.enum(Object.values(RUNTIME_ERROR_CODES_V12)),
    retryable: z.boolean(),
    details: jsonValueSchema.optional(),
  })
  .strict()
  .readonly();

export const runtimeProtocolErrorDataV13Schema = z
  .object({
    rollCode: z.enum(Object.values(RUNTIME_ERROR_CODES_V13)),
    retryable: z.boolean(),
    details: jsonValueSchema.optional(),
  })
  .strict()
  .readonly();

export const runtimeMethodSchemasV11 = {
  [RUNTIME_METHODS.initialize]: {
    params: initializeParamsSchema,
    result: initializeResultV11Schema,
  },
  [RUNTIME_METHODS.threadList]: {
    params: threadListParamsSchema,
    result: threadListResultSchema,
  },
  [RUNTIME_METHODS.threadCreate]: {
    params: threadCreateParamsSchema,
    result: threadCreateResultSchema,
  },
  [RUNTIME_METHODS.threadOpen]: {
    params: threadOpenParamsSchema,
    result: threadOpenResultV11Schema,
  },
  [RUNTIME_METHODS.threadSnapshot]: {
    params: threadSnapshotParamsV12Schema,
    result: threadSnapshotResultV11Schema,
  },
  [RUNTIME_METHODS.threadRename]: {
    params: threadRenameParamsSchema,
    result: threadRenameResultSchema,
  },
  [RUNTIME_METHODS.threadDelete]: {
    params: threadDeleteParamsSchema,
    result: threadDeleteResultSchema,
  },
  [RUNTIME_METHODS.threadDetach]: {
    params: threadDetachParamsSchema,
    result: threadDetachResultSchema,
  },
  [RUNTIME_METHODS.threadCapabilities]: {
    params: threadCapabilitiesParamsSchema,
    result: threadCapabilitiesResultSchema,
  },
  [RUNTIME_METHODS.turnStart]: {
    params: turnStartParamsSchema,
    result: turnStartResultSchema,
  },
  [RUNTIME_METHODS.turnCancel]: {
    params: turnCancelParamsSchema,
    result: turnCancelResultSchema,
  },
  [RUNTIME_METHODS.approvalRespond]: {
    params: approvalRespondParamsSchema,
    result: approvalRespondResultSchema,
  },
  [RUNTIME_METHODS.operationGet]: {
    params: operationGetParamsSchema,
    result: operationGetResultSchema,
  },
} as const;

export const runtimeMethodSchemasV10 = runtimeMethodSchemasV11;

export const runtimeMethodSchemasV12 = {
  ...runtimeMethodSchemasV11,
  [RUNTIME_METHODS.initialize]: {
    params: initializeParamsSchema,
    result: initializeResultV12Schema,
  },
  [RUNTIME_METHODS.threadOpen]: {
    params: threadOpenParamsSchema,
    result: threadSnapshotV12Schema,
  },
  [RUNTIME_METHODS.threadSnapshot]: {
    params: threadSnapshotParamsV12Schema,
    result: threadSnapshotResultV12Schema,
  },
  [RUNTIME_METHODS.clientCapabilitiesSet]: {
    params: clientCapabilitiesSetParamsSchema,
    result: clientCapabilitiesSetResultSchema,
  },
} as const;

export const runtimeMethodSchemasV13 = {
  ...runtimeMethodSchemasV12,
  [RUNTIME_METHODS.initialize]: {
    params: initializeParamsSchema,
    result: initializeResultV13Schema,
  },
  [RUNTIME_METHODS.threadOpen]: {
    params: threadOpenParamsSchema,
    result: threadOpenResultSchema,
  },
  [RUNTIME_METHODS.threadSnapshot]: {
    params: threadSnapshotParamsV13Schema,
    result: threadSnapshotResultSchema,
  },
  [RUNTIME_METHODS.runtimeEventsResume]: {
    params: runtimeEventsResumeParamsSchema,
    result: runtimeEventsResumeResultSchema,
  },
} as const;

/** Latest Runtime method registry. Use the version registry for negotiated availability. */
export const runtimeMethodSchemas = runtimeMethodSchemasV13;

export const runtimeServerRequestSchemasV10 = {} as const;

export const runtimeServerRequestSchemasV11 = {
  [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: {
    params: approvalRequestParamsSchema,
    result: approvalRequestResultSchema,
  },
} as const;

export const runtimeServerRequestSchemasV12 = {
  [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: {
    params: approvalRequestParamsV12Schema,
    result: approvalRequestResultSchema,
  },
  [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest]: {
    params: userInputRequestParamsV12Schema,
    result: userInputResultSchema,
  },
} as const;

export const runtimeServerRequestSchemasV13 = runtimeServerRequestSchemasV12;

/** Protocol 1.1 compatibility facade. Prefer the version registry in new code. */
export const runtimeServerRequestSchemas = runtimeServerRequestSchemasV11;

interface RuntimeMethodSchemaPair {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
}

export interface RuntimeProtocolRegistry {
  readonly methods: Readonly<Record<string, RuntimeMethodSchemaPair>>;
  readonly serverRequests: Readonly<Record<string, RuntimeMethodSchemaPair>>;
  readonly serverRequestMethods: readonly RuntimeServerRequestMethod[];
  readonly serverRequestCancelParamsSchema: z.ZodType | null;
  readonly eventEnvelopeSchema: z.ZodType;
  readonly errorDataSchema: z.ZodType;
}

export const RUNTIME_PROTOCOL_REGISTRY = {
  "1.3": {
    methods: runtimeMethodSchemasV13,
    serverRequests: runtimeServerRequestSchemasV13,
    serverRequestMethods: RUNTIME_SERVER_REQUEST_METHOD_VALUES,
    serverRequestCancelParamsSchema: runtimeServerRequestCancelParamsV12Schema,
    eventEnvelopeSchema: runtimeEventEnvelopeV13Schema,
    errorDataSchema: runtimeProtocolErrorDataV13Schema,
  },
  "1.2": {
    methods: runtimeMethodSchemasV12,
    serverRequests: runtimeServerRequestSchemasV12,
    serverRequestMethods: RUNTIME_SERVER_REQUEST_METHOD_VALUES,
    serverRequestCancelParamsSchema: runtimeServerRequestCancelParamsV12Schema,
    eventEnvelopeSchema: runtimeEventEnvelopeV12Schema,
    errorDataSchema: runtimeProtocolErrorDataV12Schema,
  },
  "1.1": {
    methods: runtimeMethodSchemasV11,
    serverRequests: runtimeServerRequestSchemasV11,
    serverRequestMethods: RUNTIME_SERVER_REQUEST_METHOD_VALUES_V11,
    serverRequestCancelParamsSchema: runtimeServerRequestCancelParamsV11Schema,
    eventEnvelopeSchema: runtimeEventEnvelopeV11Schema,
    errorDataSchema: runtimeProtocolErrorDataV11Schema,
  },
  "1.0": {
    methods: runtimeMethodSchemasV10,
    serverRequests: runtimeServerRequestSchemasV10,
    serverRequestMethods: [],
    serverRequestCancelParamsSchema: null,
    eventEnvelopeSchema: runtimeEventEnvelopeV11Schema,
    errorDataSchema: runtimeProtocolErrorDataV11Schema,
  },
} as const satisfies Readonly<Record<RuntimeProtocolVersion, RuntimeProtocolRegistry>>;

type RuntimeProtocolRegistryMap = typeof RUNTIME_PROTOCOL_REGISTRY;
type SchemaParams<TDefinition> = TDefinition extends {
  readonly params: infer TSchema extends z.ZodType;
}
  ? TSchema
  : never;
type SchemaResult<TDefinition> = TDefinition extends {
  readonly result: infer TSchema extends z.ZodType;
}
  ? TSchema
  : never;

export type RuntimeMethodForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends RuntimeProtocolVersion
    ? Extract<keyof RuntimeProtocolRegistryMap[TVersion]["methods"], string>
    : never;
type RuntimeMethodDefinitionForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeMethodForVersion<TVersion>,
> = TVersion extends RuntimeProtocolVersion
  ? TMethod extends keyof RuntimeProtocolRegistryMap[TVersion]["methods"]
    ? RuntimeProtocolRegistryMap[TVersion]["methods"][TMethod]
    : never
  : never;
export type RuntimeMethodInputForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeMethodForVersion<TVersion>,
> = z.input<SchemaParams<RuntimeMethodDefinitionForVersion<TVersion, TMethod>>>;
export type RuntimeMethodParamsForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeMethodForVersion<TVersion>,
> = z.output<SchemaParams<RuntimeMethodDefinitionForVersion<TVersion, TMethod>>>;
export type RuntimeMethodResultForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeMethodForVersion<TVersion>,
> = z.output<SchemaResult<RuntimeMethodDefinitionForVersion<TVersion, TMethod>>>;

export type RuntimeServerRequestMethodForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends RuntimeProtocolVersion
    ? Extract<
        keyof RuntimeProtocolRegistryMap[TVersion]["serverRequests"],
        RuntimeServerRequestMethod
      >
    : never;
type RuntimeServerRequestDefinitionForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>,
> = TVersion extends RuntimeProtocolVersion
  ? TMethod extends keyof RuntimeProtocolRegistryMap[TVersion]["serverRequests"]
    ? RuntimeProtocolRegistryMap[TVersion]["serverRequests"][TMethod]
    : never
  : never;
export type RuntimeServerRequestInputForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>,
> = z.input<SchemaParams<RuntimeServerRequestDefinitionForVersion<TVersion, TMethod>>>;
export type RuntimeServerRequestParamsForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>,
> = z.output<SchemaParams<RuntimeServerRequestDefinitionForVersion<TVersion, TMethod>>>;
export type RuntimeServerRequestResultForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>,
> = z.output<SchemaResult<RuntimeServerRequestDefinitionForVersion<TVersion, TMethod>>>;
export type RuntimeServerRequestInputForSupportedVersions<
  TMethod extends RuntimeServerRequestMethod,
> = {
  [TVersion in RuntimeProtocolVersion]: TMethod extends RuntimeServerRequestMethodForVersion<TVersion>
    ? RuntimeServerRequestInputForVersion<
        TVersion,
        Extract<TMethod, RuntimeServerRequestMethodForVersion<TVersion>>
      >
    : never;
}[RuntimeProtocolVersion];
export type RuntimeServerRequestParamsForSupportedVersions<
  TMethod extends RuntimeServerRequestMethod,
> = {
  [TVersion in RuntimeProtocolVersion]: TMethod extends RuntimeServerRequestMethodForVersion<TVersion>
    ? RuntimeServerRequestParamsForVersion<
        TVersion,
        Extract<TMethod, RuntimeServerRequestMethodForVersion<TVersion>>
      >
    : never;
}[RuntimeProtocolVersion];
export type RuntimeServerRequestResultForSupportedVersions<
  TMethod extends RuntimeServerRequestMethod,
> = {
  [TVersion in RuntimeProtocolVersion]: TMethod extends RuntimeServerRequestMethodForVersion<TVersion>
    ? RuntimeServerRequestResultForVersion<
        TVersion,
        Extract<TMethod, RuntimeServerRequestMethodForVersion<TVersion>>
      >
    : never;
}[RuntimeProtocolVersion];
export type RuntimeServerRequestHandlerForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>,
> = (
  params: RuntimeServerRequestParamsForVersion<TVersion, TMethod>,
) =>
  | RuntimeServerRequestResultForVersion<TVersion, TMethod>
  | Promise<RuntimeServerRequestResultForVersion<TVersion, TMethod>>;
export type RuntimeServerRequestHandlersForVersion<TVersion extends RuntimeProtocolVersion> = {
  readonly [TMethod in RuntimeServerRequestMethodForVersion<TVersion>]?: RuntimeServerRequestHandlerForVersion<
    TVersion,
    TMethod
  >;
};

/** Protocol 1.1 compatibility method union. Use RuntimeMethodForVersion in new code. */
export type RuntimeMethod = keyof typeof runtimeMethodSchemasV11;
export type LatestRuntimeMethod = keyof typeof runtimeMethodSchemas;
export type LegacyRuntimeServerRequestMethod = RuntimeServerRequestMethodForVersion<"1.1">;
export type LatestRuntimeServerRequestMethod = RuntimeServerRequestMethodForVersion<
  typeof RUNTIME_PROTOCOL_VERSION
>;
export type RuntimeMethodInput<TMethod extends RuntimeMethod> = z.input<
  (typeof runtimeMethodSchemasV11)[TMethod]["params"]
>;
export type RuntimeMethodParams<TMethod extends RuntimeMethod> = z.output<
  (typeof runtimeMethodSchemasV11)[TMethod]["params"]
>;
export type RuntimeMethodResult<TMethod extends RuntimeMethod> = z.output<
  (typeof runtimeMethodSchemasV11)[TMethod]["result"]
>;
export type LatestRuntimeServerRequestInput<TMethod extends LatestRuntimeServerRequestMethod> =
  RuntimeServerRequestInputForVersion<typeof RUNTIME_PROTOCOL_VERSION, TMethod>;
export type LatestRuntimeServerRequestParams<TMethod extends LatestRuntimeServerRequestMethod> =
  RuntimeServerRequestParamsForVersion<typeof RUNTIME_PROTOCOL_VERSION, TMethod>;
export type LatestRuntimeServerRequestResult<TMethod extends LatestRuntimeServerRequestMethod> =
  RuntimeServerRequestResultForVersion<typeof RUNTIME_PROTOCOL_VERSION, TMethod>;
export type RuntimeServerRequestInput<TMethod extends LegacyRuntimeServerRequestMethod> =
  RuntimeServerRequestInputForVersion<"1.1", TMethod>;
export type RuntimeServerRequestParams<TMethod extends LegacyRuntimeServerRequestMethod> =
  RuntimeServerRequestParamsForVersion<"1.1", TMethod>;
export type RuntimeServerRequestResult<TMethod extends LegacyRuntimeServerRequestMethod> =
  RuntimeServerRequestResultForVersion<"1.1", TMethod>;
export type RuntimeServerRequestHandler<TMethod extends LegacyRuntimeServerRequestMethod> = (
  params: RuntimeServerRequestParams<TMethod>,
) => RuntimeServerRequestResult<TMethod> | Promise<RuntimeServerRequestResult<TMethod>>;
export type RuntimeServerRequestHandlers = {
  readonly [TMethod in LegacyRuntimeServerRequestMethod]?: RuntimeServerRequestHandler<TMethod>;
};
export type InitializeParams = z.output<typeof initializeParamsSchema>;
export type InitializeResult = z.output<typeof initializeResultSchema>;
export type InitializeResultV11 = z.output<typeof initializeResultV11Schema>;
export type InitializeResultV12 = z.output<typeof initializeResultV12Schema>;
export type InitializeResultV13 = z.output<typeof initializeResultV13Schema>;
export type ClientCapabilitiesSetParams = z.output<typeof clientCapabilitiesSetParamsSchema>;
export type ClientCapabilitiesSetResult = z.output<typeof clientCapabilitiesSetResultSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeEventV11 = z.infer<typeof runtimeEventV11Schema>;
export type RuntimeEventV12 = z.infer<typeof runtimeEventV12Schema>;
export type RuntimeDurableEventV13 = z.infer<typeof runtimeDurableEventV13Schema>;
export type RuntimeEphemeralEventV13 = z.infer<typeof runtimeEphemeralEventV13Schema>;
export type RuntimeEventV13 = z.infer<typeof runtimeEventV13Schema>;
export type RuntimeEventEnvelope = z.infer<typeof runtimeEventEnvelopeSchema>;
export type RuntimeEventEnvelopeV11 = z.infer<typeof runtimeEventEnvelopeV11Schema>;
export type RuntimeEventEnvelopeV12 = z.infer<typeof runtimeEventEnvelopeV12Schema>;
export type RuntimeDurableEventEnvelopeV13 = z.infer<typeof runtimeDurableEventEnvelopeV13Schema>;
export type RuntimeEphemeralEventEnvelopeV13 = z.infer<
  typeof runtimeEphemeralEventEnvelopeV13Schema
>;
export type RuntimeEventEnvelopeV13 = z.infer<typeof runtimeEventEnvelopeV13Schema>;
export type RuntimeEventEnvelopeForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends "1.3"
    ? RuntimeEventEnvelopeV13
    : TVersion extends "1.2"
      ? RuntimeEventEnvelopeV12
      : RuntimeEventEnvelopeV11;
export type RuntimeProtocolErrorData = z.infer<typeof runtimeProtocolErrorDataSchema>;
export type RuntimeProtocolErrorDataV12 = z.infer<typeof runtimeProtocolErrorDataV12Schema>;
export type RuntimeProtocolErrorDataV13 = z.infer<typeof runtimeProtocolErrorDataV13Schema>;
export type RuntimeProtocolErrorDataForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends RuntimeProtocolVersion
    ? z.output<RuntimeProtocolRegistryMap[TVersion]["errorDataSchema"]>
    : never;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
export type ThreadSnapshotV11 = z.infer<typeof threadSnapshotV11Schema>;
export type ThreadSnapshotV12 = z.infer<typeof threadSnapshotV12Schema>;
export type ThreadSnapshotV13Full = z.infer<typeof threadSnapshotV13FullSchema>;
export type ThreadRecoverySnapshotV13 = z.infer<typeof threadRecoverySnapshotV13Schema>;
export type ThreadSnapshotV13 = z.infer<typeof threadSnapshotV13Schema>;
export type ThreadSnapshotForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends "1.3"
    ? ThreadSnapshotV13
    : TVersion extends "1.2"
      ? ThreadSnapshotV12
      : ThreadSnapshotV11;
export type UiMessage = z.infer<typeof uiMessageSchema>;
export type OperationView = z.infer<typeof operationViewSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type PendingInteractionProjection = z.infer<typeof pendingInteractionProjectionSchema>;
export type UserInputTextControl = z.infer<typeof userInputTextControlSchema>;
export type UserInputMultilineControl = z.infer<typeof userInputMultilineControlSchema>;
export type UserInputNumberControl = z.infer<typeof userInputNumberControlSchema>;
export type UserInputBooleanControl = z.infer<typeof userInputBooleanControlSchema>;
export type UserInputChoiceOption = z.infer<typeof userInputChoiceOptionSchema>;
export type UserInputChoiceControl = z.infer<typeof userInputChoiceControlSchema>;
export type UserInputControl = z.infer<typeof userInputControlSchema>;
export type UserInputForm = z.infer<typeof userInputFormSchema>;
export type UserInputRequestParamsV12 = z.infer<typeof userInputRequestParamsV12Schema>;
export type UserInputSubmittedValue = z.infer<typeof userInputSubmittedValueSchema>;
export type UserInputSubmittedResult = z.infer<typeof userInputSubmittedResultSchema>;
export type UserInputCancelledResult = z.infer<typeof userInputCancelledResultSchema>;
export type UserInputResult = z.infer<typeof userInputResultSchema>;
/** A submitted result whose values were correlated and ordered against the original form. */
export type NormalizedUserInputResult = UserInputResult;
export type ApprovalExplanation = z.infer<typeof approvalExplanationSchema>;
export type ActiveTurn = z.infer<typeof activeTurnSchema>;
export type ActiveTurnV11 = z.infer<typeof activeTurnV11Schema>;
export type ActiveTurnV12 = z.infer<typeof activeTurnV12Schema>;
export type ApprovalRequestParams = z.infer<typeof approvalRequestParamsSchema>;
export type ApprovalRequestParamsV11 = z.infer<typeof approvalRequestParamsV11Schema>;
export type ApprovalRequestParamsV12 = z.infer<typeof approvalRequestParamsV12Schema>;
export type ApprovalRequestResult = z.infer<typeof approvalRequestResultSchema>;
export type ApprovalResolution = z.infer<typeof approvalResolutionSchema>;
export type RuntimeInteractionMetadata = z.infer<typeof runtimeInteractionMetadataSchema>;
export type RuntimeServerRequestCancelParams = z.infer<
  typeof runtimeServerRequestCancelParamsSchema
>;
export type RuntimeServerRequestCancelParamsV11 = z.infer<
  typeof runtimeServerRequestCancelParamsV11Schema
>;
export type RuntimeServerRequestCancelParamsV12 = z.infer<
  typeof runtimeServerRequestCancelParamsV12Schema
>;
export type RuntimeServerRequestCancelProjectionInput = z.infer<
  typeof runtimeServerRequestCancelProjectionInputSchema
>;
export type RuntimeEventsResumeParams = z.infer<typeof runtimeEventsResumeParamsSchema>;
export type RuntimeEventsResumeResult = z.infer<typeof runtimeEventsResumeResultSchema>;
type SchemaOutputOrNever<TSchema> = TSchema extends z.ZodType ? z.output<TSchema> : never;
export type RuntimeServerRequestCancelParamsForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends RuntimeProtocolVersion
    ? SchemaOutputOrNever<RuntimeProtocolRegistryMap[TVersion]["serverRequestCancelParamsSchema"]>
    : never;
export type ProjectedRuntimeServerRequestParams<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<"1.3">,
> =
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>
    ? RuntimeServerRequestParamsForVersion<TVersion, TMethod>
    : never;

export function getRuntimeProtocolRegistry<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
): RuntimeProtocolRegistryMap[TVersion] {
  return RUNTIME_PROTOCOL_REGISTRY[version];
}

export function isRuntimeMethodAvailable<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  method: string,
): method is RuntimeMethodForVersion<TVersion> {
  return Object.hasOwn(getRuntimeProtocolRegistry(version).methods, method);
}

export function isRuntimeServerRequestMethodAvailable<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  method: string,
): method is RuntimeServerRequestMethodForVersion<TVersion> {
  return Object.hasOwn(getRuntimeProtocolRegistry(version).serverRequests, method);
}

export function projectClientCapabilitiesSetResult(value: unknown): ClientCapabilitiesSetResult {
  const params = clientCapabilitiesSetParamsSchema.parse(value);
  const requested = new Set(params.serverRequestMethods);
  return clientCapabilitiesSetResultSchema.parse({
    revision: params.revision,
    acceptedServerRequestMethods: RUNTIME_PROTOCOL_REGISTRY[
      RUNTIME_PROTOCOL_VERSION
    ].serverRequestMethods.filter((method) => requested.has(method)),
  });
}

export function getApprovalExplanation(
  approval: Pick<PendingApproval, "preview">,
): ApprovalExplanation | undefined {
  const preview = approval.preview;
  if (typeof preview !== "object" || preview === null || Array.isArray(preview)) {
    return undefined;
  }
  const parsed = approvalExplanationSchema.safeParse(preview[APPROVAL_EXPLANATION_PREVIEW_KEY]);
  return parsed.success ? parsed.data : undefined;
}

type UserInputValidationPath = readonly (string | number)[];
type AddUserInputValidationIssue = (path: UserInputValidationPath, message: string) => void;
type UserInputValueValidator = (
  control: UserInputControl,
  value: UserInputSubmittedValue["value"],
  path: UserInputValidationPath,
  addIssue: AddUserInputValidationIssue,
) => void;

function validateUserInputTextValue(
  control: UserInputTextControl | UserInputMultilineControl,
  value: UserInputSubmittedValue["value"],
  path: UserInputValidationPath,
  addIssue: AddUserInputValidationIssue,
): void {
  if (typeof value !== "string") {
    addIssue(path, `${control.type} control requires a string value`);
    return;
  }
  const minimum = Math.max(control.minLength ?? 0, control.required ? 1 : 0);
  const maximum = control.maxLength ?? USER_INPUT_TEXT_MAX_CHARS;
  if (value.length < minimum) {
    addIssue(path, `string value must contain at least ${String(minimum)} characters`);
  }
  if (value.length > maximum) {
    addIssue(path, `string value must contain at most ${String(maximum)} characters`);
  }
}

const USER_INPUT_VALUE_VALIDATORS = {
  [USER_INPUT_CONTROL_TYPES.text]: ((control, value, path, addIssue) => {
    validateUserInputTextValue(userInputTextControlSchema.parse(control), value, path, addIssue);
  }) satisfies UserInputValueValidator,
  [USER_INPUT_CONTROL_TYPES.multiline]: ((control, value, path, addIssue) => {
    validateUserInputTextValue(
      userInputMultilineControlSchema.parse(control),
      value,
      path,
      addIssue,
    );
  }) satisfies UserInputValueValidator,
  [USER_INPUT_CONTROL_TYPES.number]: ((control, value, path, addIssue) => {
    const numberControl = userInputNumberControlSchema.parse(control);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      addIssue(path, "number control requires a finite number value");
      return;
    }
    if (numberControl.integer === true && !Number.isInteger(value)) {
      addIssue(path, "number control requires an integer value");
    }
    if (numberControl.min !== undefined && value < numberControl.min) {
      addIssue(path, `number value must be at least ${String(numberControl.min)}`);
    }
    if (numberControl.max !== undefined && value > numberControl.max) {
      addIssue(path, `number value must be at most ${String(numberControl.max)}`);
    }
  }) satisfies UserInputValueValidator,
  [USER_INPUT_CONTROL_TYPES.boolean]: ((control, value, path, addIssue) => {
    userInputBooleanControlSchema.parse(control);
    if (typeof value !== "boolean") {
      addIssue(path, "boolean control requires a boolean value");
    }
  }) satisfies UserInputValueValidator,
  [USER_INPUT_CONTROL_TYPES.choice]: ((control, value, path, addIssue) => {
    const choiceControl = userInputChoiceControlSchema.parse(control);
    const optionIds = new Set(choiceControl.options.map((option) => option.id));
    if (!choiceControl.multiple) {
      if (typeof value !== "string") {
        addIssue(path, "single-choice control requires one option id");
        return;
      }
      if (!optionIds.has(value)) {
        addIssue(path, `unknown choice option id: ${value}`);
      }
      return;
    }
    if (!Array.isArray(value)) {
      addIssue(path, "multiple-choice control requires an array of option ids");
      return;
    }
    const selected = new Set<string>();
    for (const [index, optionId] of value.entries()) {
      if (selected.has(optionId)) {
        addIssue([...path, index], `duplicate choice option id: ${optionId}`);
      }
      selected.add(optionId);
      if (!optionIds.has(optionId)) {
        addIssue([...path, index], `unknown choice option id: ${optionId}`);
      }
    }
    const minimum = Math.max(choiceControl.minSelections ?? 0, choiceControl.required ? 1 : 0);
    const maximum = choiceControl.maxSelections ?? choiceControl.options.length;
    if (value.length < minimum) {
      addIssue(path, `choice value must contain at least ${String(minimum)} selections`);
    }
    if (value.length > maximum) {
      addIssue(path, `choice value must contain at most ${String(maximum)} selections`);
    }
  }) satisfies UserInputValueValidator,
} as const satisfies Readonly<Record<UserInputControl["type"], UserInputValueValidator>>;

function userInputControlRequiresValue(control: UserInputControl): boolean {
  if (control.required) {
    return true;
  }
  return control.type === USER_INPUT_CONTROL_TYPES.choice && (control.minSelections ?? 0) > 0;
}

/**
 * Correlates a structurally valid Client result with the original request and returns values in
 * form definition order. Unknown, duplicate, missing or type-incompatible values are rejected.
 */
export function normalizeUserInputResult(
  params: UserInputRequestParamsV12,
  result: unknown,
): NormalizedUserInputResult {
  const parsedParams = userInputRequestParamsV12Schema.parse(params);
  const parsedResult = userInputResultSchema.parse(result);
  if (parsedResult.status === "cancelled") {
    return parsedResult;
  }
  const controlsById = new Map(parsedParams.controls.map((control) => [control.id, control]));
  const correlatedResult = userInputSubmittedResultSchema
    .superRefine((submitted, context) => {
      const submittedControlIds = new Set<string>();
      const addIssue: AddUserInputValidationIssue = (path, message) => {
        context.addIssue({ code: "custom", message, path: [...path] });
      };
      for (const [index, submittedValue] of submitted.values.entries()) {
        const path = ["values", index, "value"] as const;
        if (submittedControlIds.has(submittedValue.id)) {
          addIssue(["values", index, "id"], `duplicate control id: ${submittedValue.id}`);
          continue;
        }
        submittedControlIds.add(submittedValue.id);
        const control = controlsById.get(submittedValue.id);
        if (control === undefined) {
          addIssue(["values", index, "id"], `unknown control id: ${submittedValue.id}`);
          continue;
        }
        USER_INPUT_VALUE_VALIDATORS[control.type](control, submittedValue.value, path, addIssue);
      }
      for (const control of parsedParams.controls) {
        if (userInputControlRequiresValue(control) && !submittedControlIds.has(control.id)) {
          addIssue(["values"], `required control is missing: ${control.id}`);
        }
      }
    })
    .parse(parsedResult);
  const submittedById = new Map(correlatedResult.values.map((value) => [value.id, value]));
  return userInputSubmittedResultSchema.parse({
    status: "submitted",
    values: parsedParams.controls.flatMap((control) => {
      const value = submittedById.get(control.id);
      return value === undefined ? [] : [value];
    }),
  });
}

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: RuntimeProtocolErrorData;
  };
}

export interface JsonRpcErrorResponseForVersion<TVersion extends RuntimeProtocolVersion> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: RuntimeProtocolErrorDataForVersion<TVersion>;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type JsonRpcMessageForVersion<TVersion extends RuntimeProtocolVersion> =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponseForVersion<TVersion>;

export function isRuntimeMethod(value: string): value is RuntimeMethod {
  return Object.hasOwn(runtimeMethodSchemasV11, value);
}

function runtimeProtocolSchemaUnavailable(
  version: RuntimeProtocolVersion,
  kind: "method" | "server request" | "server request cancellation",
  name?: string,
): never {
  const suffix = name === undefined ? "" : ` ${name}`;
  throw new Error(`Runtime Protocol ${version} does not support ${kind}${suffix}`);
}

export function parseRuntimeMethodParamsForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeMethodForVersion<TVersion>,
>(
  version: TVersion,
  method: TMethod,
  value: unknown,
): RuntimeMethodParamsForVersion<TVersion, TMethod> {
  const methods: Readonly<Record<string, RuntimeMethodSchemaPair>> =
    getRuntimeProtocolRegistry(version).methods;
  const definition = methods[method];
  if (definition === undefined) {
    return runtimeProtocolSchemaUnavailable(version, "method", method);
  }
  return definition.params.parse(value) as RuntimeMethodParamsForVersion<TVersion, TMethod>;
}

export function parseRuntimeMethodResultForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeMethodForVersion<TVersion>,
>(
  version: TVersion,
  method: TMethod,
  value: unknown,
): RuntimeMethodResultForVersion<TVersion, TMethod> {
  const methods: Readonly<Record<string, RuntimeMethodSchemaPair>> =
    getRuntimeProtocolRegistry(version).methods;
  const definition = methods[method];
  if (definition === undefined) {
    return runtimeProtocolSchemaUnavailable(version, "method", method);
  }
  return definition.result.parse(value) as RuntimeMethodResultForVersion<TVersion, TMethod>;
}

export function parseRuntimeMethodParams<TMethod extends RuntimeMethod>(
  method: TMethod,
  value: unknown,
): RuntimeMethodParams<TMethod> {
  return runtimeMethodSchemasV11[method].params.parse(value) as RuntimeMethodParams<TMethod>;
}

export function parseRuntimeMethodResult<TMethod extends RuntimeMethod>(
  method: TMethod,
  value: unknown,
): RuntimeMethodResult<TMethod> {
  return runtimeMethodSchemasV11[method].result.parse(value) as RuntimeMethodResult<TMethod>;
}

export function projectThreadSnapshotForVersion<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  value: unknown,
): ThreadSnapshotForVersion<TVersion> {
  const latest = threadSnapshotV13Schema.safeParse(value);
  if (version === "1.3") {
    if (!latest.success) {
      throw latest.error;
    }
    return latest.data as ThreadSnapshotForVersion<TVersion>;
  }
  const v12 = latest.success
    ? threadSnapshotV12Schema.parse({
        thread: latest.data.thread,
        messages: latest.data.messages,
        operations: latest.data.operations,
        ...(latest.data.activeTurn === undefined ? {} : { activeTurn: latest.data.activeTurn }),
        pendingApprovals: latest.data.pendingApprovals,
        pendingInteractions: latest.data.pendingInteractions,
        transcriptCompleteness: latest.data.transcriptCompleteness,
      })
    : threadSnapshotV12Schema.parse(value);
  if (version === "1.2") {
    return v12 as ThreadSnapshotForVersion<TVersion>;
  }
  return threadSnapshotV11Schema.parse({
    thread: v12.thread,
    messages: v12.messages,
    operations: v12.operations,
    ...(v12.activeTurn === undefined
      ? {}
      : {
          activeTurn: {
            ...v12.activeTurn,
            status:
              v12.activeTurn.status === "waiting-for-user" ? "running" : v12.activeTurn.status,
          },
        }),
    pendingApprovals: v12.pendingApprovals,
    transcriptCompleteness: v12.transcriptCompleteness,
  }) as ThreadSnapshotForVersion<TVersion>;
}

export function projectRuntimeEventEnvelopeForVersion<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  value: unknown,
): RuntimeEventEnvelopeForVersion<TVersion> {
  const source = runtimeEventEnvelopeSchema.parse(value);
  if (version === "1.3") {
    return runtimeEventEnvelopeV13Schema.parse(source) as RuntimeEventEnvelopeForVersion<TVersion>;
  }
  const projectedEnvelopeFields = {
    runtimeInstanceId: source.runtimeInstanceId,
    sequence: source.sequence,
    timestamp: source.timestamp,
    threadId: source.threadId,
    ...(source.turnId === undefined ? {} : { turnId: source.turnId }),
  } as const;
  if (version === "1.2") {
    return runtimeEventEnvelopeV12Schema.parse({
      protocolVersion: version,
      ...projectedEnvelopeFields,
      event: runtimeEventV12Schema.parse(source.event),
    }) as RuntimeEventEnvelopeForVersion<TVersion>;
  }
  return runtimeEventEnvelopeV11Schema.parse({
    protocolVersion: version,
    ...projectedEnvelopeFields,
    event: runtimeEventV11Schema.parse(source.event),
  }) as RuntimeEventEnvelopeForVersion<TVersion>;
}

export function isRuntimeServerRequestMethod(
  value: string,
): value is LegacyRuntimeServerRequestMethod {
  return Object.hasOwn(runtimeServerRequestSchemas, value);
}

export function isLatestRuntimeServerRequestMethod(
  value: string,
): value is LatestRuntimeServerRequestMethod {
  return Object.hasOwn(runtimeServerRequestSchemasV13, value);
}

export function parseRuntimeServerRequestParamsForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>,
>(
  version: TVersion,
  method: TMethod,
  value: unknown,
): RuntimeServerRequestParamsForVersion<TVersion, TMethod> {
  const serverRequests: Readonly<Record<string, RuntimeMethodSchemaPair>> =
    getRuntimeProtocolRegistry(version).serverRequests;
  const definition = serverRequests[method];
  if (definition === undefined) {
    return runtimeProtocolSchemaUnavailable(version, "server request", method);
  }
  return definition.params.parse(value) as RuntimeServerRequestParamsForVersion<TVersion, TMethod>;
}

export function parseRuntimeServerRequestResultForVersion<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<TVersion>,
>(
  version: TVersion,
  method: TMethod,
  value: unknown,
): RuntimeServerRequestResultForVersion<TVersion, TMethod> {
  const serverRequests: Readonly<Record<string, RuntimeMethodSchemaPair>> =
    getRuntimeProtocolRegistry(version).serverRequests;
  const definition = serverRequests[method];
  if (definition === undefined) {
    return runtimeProtocolSchemaUnavailable(version, "server request", method);
  }
  return definition.result.parse(value) as RuntimeServerRequestResultForVersion<TVersion, TMethod>;
}

export function parseRuntimeServerRequestCancelParamsForVersion<
  TVersion extends RuntimeProtocolVersion,
>(version: TVersion, value: unknown): RuntimeServerRequestCancelParamsForVersion<TVersion> {
  const schema = getRuntimeProtocolRegistry(version).serverRequestCancelParamsSchema;
  if (schema === null) {
    return runtimeProtocolSchemaUnavailable(version, "server request cancellation");
  }
  return schema.parse(value) as RuntimeServerRequestCancelParamsForVersion<TVersion>;
}

export function parseRuntimeProtocolErrorDataForVersion<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  value: unknown,
): RuntimeProtocolErrorDataForVersion<TVersion> {
  return getRuntimeProtocolRegistry(version).errorDataSchema.parse(
    value,
  ) as RuntimeProtocolErrorDataForVersion<TVersion>;
}

export function projectRuntimeServerRequestParams<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<"1.3">,
>(
  version: TVersion,
  method: TMethod,
  value: RuntimeServerRequestInputForVersion<"1.3", TMethod>,
): ProjectedRuntimeServerRequestParams<TVersion, TMethod> {
  const latest = parseRuntimeServerRequestParamsForVersion("1.3", method, value);
  if (version === "1.3" || version === "1.2") {
    return latest as ProjectedRuntimeServerRequestParams<TVersion, TMethod>;
  }
  if (version === "1.1" && method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest) {
    const approval = approvalRequestParamsV12Schema.parse(latest);
    return approvalRequestParamsV11Schema.parse({
      threadId: approval.threadId,
      approval: approval.approval,
      expiresAt: approval.expiresAt,
    }) as ProjectedRuntimeServerRequestParams<TVersion, TMethod>;
  }
  return runtimeProtocolSchemaUnavailable(version, "server request", method);
}

export function projectRuntimeServerRequestCancelParams<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  value: RuntimeServerRequestCancelProjectionInput,
): RuntimeServerRequestCancelParamsForVersion<TVersion> {
  const input = runtimeServerRequestCancelProjectionInputSchema.parse(value);
  if (version === "1.3" || version === "1.2") {
    return runtimeServerRequestCancelParamsV12Schema.parse({
      interactionId: input.interactionId,
      reason: input.reason,
    }) as RuntimeServerRequestCancelParamsForVersion<TVersion>;
  }
  if (version === "1.1") {
    return runtimeServerRequestCancelParamsV11Schema.parse({
      serverRequestId: input.serverRequestId,
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      reason: input.reason,
    }) as RuntimeServerRequestCancelParamsForVersion<TVersion>;
  }
  return runtimeProtocolSchemaUnavailable(version, "server request cancellation");
}

export function parseRuntimeServerRequestParams<TMethod extends LegacyRuntimeServerRequestMethod>(
  method: TMethod,
  value: unknown,
): RuntimeServerRequestParams<TMethod> {
  return runtimeServerRequestSchemas[method].params.parse(
    value,
  ) as RuntimeServerRequestParams<TMethod>;
}

export function parseRuntimeServerRequestResult<TMethod extends LegacyRuntimeServerRequestMethod>(
  method: TMethod,
  value: unknown,
): RuntimeServerRequestResult<TMethod> {
  return runtimeServerRequestSchemas[method].result.parse(
    value,
  ) as RuntimeServerRequestResult<TMethod>;
}
