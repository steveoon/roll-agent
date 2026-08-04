import { z } from "zod/v4";

export const SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11 = ["1.1", "1.0"] as const;
export const SUPPORTED_RUNTIME_PROTOCOL_VERSIONS = [
  "1.2",
  ...SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11,
] as const;
export type RuntimeProtocolVersion = (typeof SUPPORTED_RUNTIME_PROTOCOL_VERSIONS)[number];
export const RUNTIME_PROTOCOL_VERSION = SUPPORTED_RUNTIME_PROTOCOL_VERSIONS[0];
export const RUNTIME_EVENT_NOTIFICATION = "runtime.event" as const;
export const RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION = "runtime.serverRequest.cancel" as const;
export const APPROVAL_EXPLANATION_PREVIEW_KEY = "explanation" as const;
export const APPROVAL_EXPLANATION_MAX_CHARS = 100;
export const CLIENT_CAPABILITY_METHOD_MAX_COUNT = 64;
export const CLIENT_CAPABILITY_METHOD_MAX_CHARS = 100;

export const INTERACTION_SENSITIVITIES = ["normal"] as const;

export const RUNTIME_SERVER_REQUEST_METHODS = {
  approvalRequest: "approval.request",
} as const;

export const RUNTIME_SERVER_REQUEST_METHOD_VALUES = [
  RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
] as const;

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

export const RUNTIME_ERROR_CODES = {
  ...RUNTIME_ERROR_CODES_V11,
  capabilityRevisionConflict: "CAPABILITY_REVISION_CONFLICT",
} as const;

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
export const timestampSchema = z.string().datetime({ offset: true });
export const jsonValueSchema = z.json();
export const jsonRpcIdSchema = z.union([z.string(), z.number()]);
export const runtimeProtocolVersionSchema = z.enum(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS);
export const runtimeProtocolVersionV11Schema = z.enum(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS_V11);
export const interactionSensitivitySchema = z.enum(INTERACTION_SENSITIVITIES);
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
export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export type InteractionSensitivity = z.infer<typeof interactionSensitivitySchema>;

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

export const runtimeLimitsSchema = z
  .object({
    maxFrameBytes: z.number().int().positive(),
    maxPageSize: z.number().int().positive(),
    eventReplay: z.literal(false),
    idempotencyCacheEntries: z.number().int().positive(),
  })
  .strict()
  .readonly();

export const initializeParamsSchema = z
  .object({
    protocolVersions: z.array(z.string().min(1)).min(1),
    client: runtimeClientInfoSchema,
  })
  .strict()
  .readonly();

const initializeResultFields = {
  runtimeInstanceId: runtimeInstanceIdSchema,
  server: runtimeServerInfoSchema,
  features: z.array(z.enum(RUNTIME_FEATURES)),
  limits: runtimeLimitsSchema,
} as const;

/** Runtime Protocol 1.1/1.0 initialize result. Keep this schema frozen. */
export const initializeResultV11Schema = z
  .object({
    protocolVersion: runtimeProtocolVersionV11Schema,
    ...initializeResultFields,
  })
  .strict()
  .readonly();

/** Runtime Protocol 1.2 initialize result. */
export const initializeResultV12Schema = z
  .object({
    protocolVersion: runtimeProtocolVersionSchema,
    ...initializeResultFields,
  })
  .strict()
  .readonly();

/** Latest Runtime Protocol initialize result. */
export const initializeResultSchema = initializeResultV12Schema;

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

export const pendingInteractionProjectionSchema = z.discriminatedUnion("method", [
  pendingApprovalInteractionProjectionSchema,
]);

export const threadSnapshotV12Schema = z
  .object({
    ...threadSnapshotV11Fields,
    activeTurn: activeTurnV12Schema.optional(),
    pendingInteractions: z.array(pendingInteractionProjectionSchema),
  })
  .strict()
  .readonly();

/** Latest Runtime Protocol snapshot. Use threadSnapshotV11Schema for the compatibility facade. */
export const threadSnapshotSchema = threadSnapshotV12Schema;

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

export const threadSnapshotParamsSchema = z
  .object({
    ...threadRequestFields,
    messageBeforeSequence: z.number().int().nonnegative().optional(),
    operationBeforeSequence: z.number().int().nonnegative().optional(),
    limit: pageSizeSchema,
  })
  .strict()
  .readonly();

export const threadSnapshotResultV11Schema = threadSnapshotV11Schema;
export const threadSnapshotResultSchema = threadSnapshotSchema;

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

export const runtimeInteractionMetadataSchema = z
  .object({
    interactionId: interactionIdSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    expiresAt: timestampSchema,
    sensitivity: interactionSensitivitySchema,
  })
  .strict()
  .readonly();

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

/** Runtime Protocol 1.1/1.0 event payloads. Keep this schema frozen. */
export const runtimeEventV11Schema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("turn.started") })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("message.started"),
      streamId: streamIdSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("message.delta"),
      streamId: streamIdSchema,
      delta: z.string(),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("message.completed"),
      streamId: streamIdSchema,
      text: z.string(),
    })
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
      input: jsonValueSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("tool.output"),
      toolCallId: z.string().min(1),
      agentName: z.string().min(1),
      toolName: z.string().min(1),
      stream: z.enum(["stdout", "stderr"]),
      delta: z.string(),
    })
    .strict()
    .readonly(),
  z
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
    .readonly(),
  z
    .object({
      type: z.literal("approval.required"),
      approval: pendingApprovalSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("approval.resolved"),
      approvalId: approvalIdSchema,
      resolution: approvalResolutionSchema,
    })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("turn.completed") })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("turn.cancelled"),
      reason: z.string(),
      message: z.string(),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("turn.failed"),
      stage: z.enum(["bootstrap", "plan", "execute"]),
      message: z.string(),
    })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal("capabilities.changed") })
    .strict()
    .readonly(),
]);

/** Runtime Protocol 1.2 event payloads. Currently identical to the 1.1 payload registry. */
export const runtimeEventV12Schema = runtimeEventV11Schema;

/** Latest Runtime Protocol event payloads. */
export const runtimeEventSchema = runtimeEventV12Schema;

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

/** Latest Runtime Protocol 1.2-capable event envelope. */
export const runtimeEventEnvelopeV12Schema = z
  .object({
    protocolVersion: runtimeProtocolVersionSchema,
    ...runtimeEventEnvelopeFields,
    event: runtimeEventV12Schema,
  })
  .strict()
  .superRefine(validateRuntimeEventCapabilities)
  .readonly();

export const runtimeEventEnvelopeSchema = runtimeEventEnvelopeV12Schema;

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
    rollCode: z.enum(Object.values(RUNTIME_ERROR_CODES)),
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
    params: threadSnapshotParamsSchema,
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
    result: threadOpenResultSchema,
  },
  [RUNTIME_METHODS.threadSnapshot]: {
    params: threadSnapshotParamsSchema,
    result: threadSnapshotResultSchema,
  },
  [RUNTIME_METHODS.clientCapabilitiesSet]: {
    params: clientCapabilitiesSetParamsSchema,
    result: clientCapabilitiesSetResultSchema,
  },
} as const;

/** Latest Runtime method registry. Use the version registry for negotiated availability. */
export const runtimeMethodSchemas = runtimeMethodSchemasV12;

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
} as const;

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
  readonly errorDataSchema: z.ZodType;
}

export const RUNTIME_PROTOCOL_REGISTRY = {
  "1.2": {
    methods: runtimeMethodSchemasV12,
    serverRequests: runtimeServerRequestSchemasV12,
    serverRequestMethods: RUNTIME_SERVER_REQUEST_METHOD_VALUES,
    serverRequestCancelParamsSchema: runtimeServerRequestCancelParamsV12Schema,
    errorDataSchema: runtimeProtocolErrorDataV12Schema,
  },
  "1.1": {
    methods: runtimeMethodSchemasV11,
    serverRequests: runtimeServerRequestSchemasV11,
    serverRequestMethods: RUNTIME_SERVER_REQUEST_METHOD_VALUES,
    serverRequestCancelParamsSchema: runtimeServerRequestCancelParamsV11Schema,
    errorDataSchema: runtimeProtocolErrorDataV11Schema,
  },
  "1.0": {
    methods: runtimeMethodSchemasV10,
    serverRequests: runtimeServerRequestSchemasV10,
    serverRequestMethods: [],
    serverRequestCancelParamsSchema: null,
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
export type ClientCapabilitiesSetParams = z.output<typeof clientCapabilitiesSetParamsSchema>;
export type ClientCapabilitiesSetResult = z.output<typeof clientCapabilitiesSetResultSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeEventV11 = z.infer<typeof runtimeEventV11Schema>;
export type RuntimeEventV12 = z.infer<typeof runtimeEventV12Schema>;
export type RuntimeEventEnvelope = z.infer<typeof runtimeEventEnvelopeSchema>;
export type RuntimeEventEnvelopeV11 = z.infer<typeof runtimeEventEnvelopeV11Schema>;
export type RuntimeEventEnvelopeV12 = z.infer<typeof runtimeEventEnvelopeV12Schema>;
export type RuntimeEventEnvelopeForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends "1.2" ? RuntimeEventEnvelopeV12 : RuntimeEventEnvelopeV11;
export type RuntimeProtocolErrorData = z.infer<typeof runtimeProtocolErrorDataSchema>;
export type RuntimeProtocolErrorDataV12 = z.infer<typeof runtimeProtocolErrorDataV12Schema>;
export type RuntimeProtocolErrorDataForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends RuntimeProtocolVersion
    ? z.output<RuntimeProtocolRegistryMap[TVersion]["errorDataSchema"]>
    : never;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
export type ThreadSnapshotV11 = z.infer<typeof threadSnapshotV11Schema>;
export type ThreadSnapshotForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends "1.2" ? ThreadSnapshot : ThreadSnapshotV11;
export type UiMessage = z.infer<typeof uiMessageSchema>;
export type OperationView = z.infer<typeof operationViewSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type PendingInteractionProjection = z.infer<typeof pendingInteractionProjectionSchema>;
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
type SchemaOutputOrNever<TSchema> = TSchema extends z.ZodType ? z.output<TSchema> : never;
export type RuntimeServerRequestCancelParamsForVersion<TVersion extends RuntimeProtocolVersion> =
  TVersion extends RuntimeProtocolVersion
    ? SchemaOutputOrNever<RuntimeProtocolRegistryMap[TVersion]["serverRequestCancelParamsSchema"]>
    : never;
export type ProjectedRuntimeServerRequestParams<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<"1.2">,
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
    acceptedServerRequestMethods: RUNTIME_PROTOCOL_REGISTRY["1.2"].serverRequestMethods.filter(
      (method) => requested.has(method),
    ),
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
  const latest = threadSnapshotV12Schema.parse(value);
  if (version === "1.2") {
    return latest as ThreadSnapshotForVersion<TVersion>;
  }
  return threadSnapshotV11Schema.parse({
    thread: latest.thread,
    messages: latest.messages,
    operations: latest.operations,
    ...(latest.activeTurn === undefined
      ? {}
      : {
          activeTurn: {
            ...latest.activeTurn,
            status:
              latest.activeTurn.status === "waiting-for-user"
                ? "running"
                : latest.activeTurn.status,
          },
        }),
    pendingApprovals: latest.pendingApprovals,
    transcriptCompleteness: latest.transcriptCompleteness,
  }) as ThreadSnapshotForVersion<TVersion>;
}

export function projectRuntimeEventEnvelopeForVersion<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  value: unknown,
): RuntimeEventEnvelopeForVersion<TVersion> {
  const latest = runtimeEventEnvelopeV12Schema.parse(value);
  const projectedEnvelopeFields = {
    runtimeInstanceId: latest.runtimeInstanceId,
    sequence: latest.sequence,
    timestamp: latest.timestamp,
    threadId: latest.threadId,
    ...(latest.turnId === undefined ? {} : { turnId: latest.turnId }),
  } as const;
  if (version === "1.2") {
    return runtimeEventEnvelopeV12Schema.parse({
      protocolVersion: version,
      ...projectedEnvelopeFields,
      event: runtimeEventV12Schema.parse(latest.event),
    }) as RuntimeEventEnvelopeForVersion<TVersion>;
  }
  return runtimeEventEnvelopeV11Schema.parse({
    protocolVersion: version,
    ...projectedEnvelopeFields,
    event: runtimeEventV11Schema.parse(latest.event),
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
  return Object.hasOwn(runtimeServerRequestSchemasV12, value);
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
  TMethod extends RuntimeServerRequestMethodForVersion<"1.2">,
>(
  version: TVersion,
  method: TMethod,
  value: RuntimeServerRequestInputForVersion<"1.2", TMethod>,
): ProjectedRuntimeServerRequestParams<TVersion, TMethod> {
  const latest = parseRuntimeServerRequestParamsForVersion("1.2", method, value);
  if (version === "1.2") {
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
  if (version === "1.2") {
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
