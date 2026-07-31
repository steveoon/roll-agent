import { z } from "zod/v4";

export const SUPPORTED_RUNTIME_PROTOCOL_VERSIONS = ["1.1", "1.0"] as const;
export type RuntimeProtocolVersion = (typeof SUPPORTED_RUNTIME_PROTOCOL_VERSIONS)[number];
export const RUNTIME_PROTOCOL_VERSION = SUPPORTED_RUNTIME_PROTOCOL_VERSIONS[0];
export const RUNTIME_EVENT_NOTIFICATION = "runtime.event" as const;
export const RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION = "runtime.serverRequest.cancel" as const;
export const APPROVAL_EXPLANATION_PREVIEW_KEY = "explanation" as const;
export const APPROVAL_EXPLANATION_MAX_CHARS = 100;

export const RUNTIME_SERVER_REQUEST_METHODS = {
  approvalRequest: "approval.request",
} as const;

export type RuntimeServerRequestMethod =
  (typeof RUNTIME_SERVER_REQUEST_METHODS)[keyof typeof RUNTIME_SERVER_REQUEST_METHODS];

export interface RuntimeProtocolCapabilities {
  readonly serverRequests: boolean;
  readonly approvalResolvedEvents: boolean;
  readonly clientApprovalResponses: boolean;
  readonly requiredServerRequestMethods: readonly RuntimeServerRequestMethod[];
}

export const RUNTIME_PROTOCOL_CAPABILITIES = {
  "1.1": {
    serverRequests: true,
    approvalResolvedEvents: true,
    clientApprovalResponses: false,
    requiredServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
  },
  "1.0": {
    serverRequests: false,
    approvalResolvedEvents: false,
    clientApprovalResponses: true,
    requiredServerRequestMethods: [],
  },
} as const satisfies Readonly<Record<RuntimeProtocolVersion, RuntimeProtocolCapabilities>>;

export const REQUIRED_RUNTIME_SERVER_REQUEST_METHODS_BY_VERSION = {
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

export const RUNTIME_ERROR_CODES = {
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
export const runtimeInstanceIdSchema = z.string().uuid().brand<"RuntimeInstanceId">();
export const requestIdSchema = z.string().uuid().brand<"RequestId">();
export const streamIdSchema = z.string().uuid().brand<"StreamId">();
export const operationIdSchema = z.string().uuid().brand<"OperationId">();
export const timestampSchema = z.string().datetime({ offset: true });
export const jsonValueSchema = z.json();
export const jsonRpcIdSchema = z.union([z.string(), z.number()]);
export const runtimeProtocolVersionSchema = z.enum(SUPPORTED_RUNTIME_PROTOCOL_VERSIONS);
export const approvalExplanationSchema = z
  .string()
  .trim()
  .min(1)
  .max(APPROVAL_EXPLANATION_MAX_CHARS);

export type ThreadId = z.infer<typeof threadIdSchema>;
export type TurnId = z.infer<typeof turnIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type RuntimeInstanceId = z.infer<typeof runtimeInstanceIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type StreamId = z.infer<typeof streamIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

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

export const initializeResultSchema = z
  .object({
    protocolVersion: runtimeProtocolVersionSchema,
    runtimeInstanceId: runtimeInstanceIdSchema,
    server: runtimeServerInfoSchema,
    features: z.array(z.enum(RUNTIME_FEATURES)),
    limits: runtimeLimitsSchema,
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

export const activeTurnSchema = z
  .object({
    id: turnIdSchema,
    status: z.enum(["running", "cancelling"]),
    startedAt: timestampSchema,
  })
  .strict()
  .readonly();

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

export const threadSnapshotSchema = z
  .object({
    thread: threadSummarySchema,
    messages: messagePageSchema,
    operations: operationPageSchema,
    activeTurn: activeTurnSchema.optional(),
    pendingApprovals: z.array(pendingApprovalSchema),
    transcriptCompleteness: z.enum(["complete", "legacy_snapshot"]),
  })
  .strict()
  .readonly();

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

export const runtimeEventSchema = z.discriminatedUnion("type", [
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

export const runtimeEventEnvelopeSchema = z
  .object({
    protocolVersion: runtimeProtocolVersionSchema,
    runtimeInstanceId: runtimeInstanceIdSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: timestampSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema.optional(),
    event: runtimeEventSchema,
  })
  .strict()
  .superRefine((value, context) => {
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
  })
  .readonly();

export const runtimeProtocolErrorDataSchema = z
  .object({
    rollCode: z.enum(Object.values(RUNTIME_ERROR_CODES)),
    retryable: z.boolean(),
    details: jsonValueSchema.optional(),
  })
  .strict()
  .readonly();

export const runtimeMethodSchemas = {
  [RUNTIME_METHODS.initialize]: {
    params: initializeParamsSchema,
    result: initializeResultSchema,
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
    result: threadOpenResultSchema,
  },
  [RUNTIME_METHODS.threadSnapshot]: {
    params: threadSnapshotParamsSchema,
    result: threadSnapshotResultSchema,
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

export const runtimeServerRequestSchemas = {
  [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: {
    params: approvalRequestParamsSchema,
    result: approvalRequestResultSchema,
  },
} as const;

export type RuntimeMethod = keyof typeof runtimeMethodSchemas;
export type RuntimeMethodInput<TMethod extends RuntimeMethod> = z.input<
  (typeof runtimeMethodSchemas)[TMethod]["params"]
>;
export type RuntimeMethodParams<TMethod extends RuntimeMethod> = z.output<
  (typeof runtimeMethodSchemas)[TMethod]["params"]
>;
export type RuntimeMethodResult<TMethod extends RuntimeMethod> = z.output<
  (typeof runtimeMethodSchemas)[TMethod]["result"]
>;
export type RuntimeServerRequestInput<TMethod extends RuntimeServerRequestMethod> = z.input<
  (typeof runtimeServerRequestSchemas)[TMethod]["params"]
>;
export type RuntimeServerRequestParams<TMethod extends RuntimeServerRequestMethod> = z.output<
  (typeof runtimeServerRequestSchemas)[TMethod]["params"]
>;
export type RuntimeServerRequestResult<TMethod extends RuntimeServerRequestMethod> = z.output<
  (typeof runtimeServerRequestSchemas)[TMethod]["result"]
>;
export type RuntimeServerRequestHandler<TMethod extends RuntimeServerRequestMethod> = (
  params: RuntimeServerRequestParams<TMethod>,
) => RuntimeServerRequestResult<TMethod> | Promise<RuntimeServerRequestResult<TMethod>>;
export type RuntimeServerRequestHandlers = {
  readonly [TMethod in RuntimeServerRequestMethod]?: RuntimeServerRequestHandler<TMethod>;
};
export type InitializeParams = z.output<typeof initializeParamsSchema>;
export type InitializeResult = z.output<typeof initializeResultSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeEventEnvelope = z.infer<typeof runtimeEventEnvelopeSchema>;
export type RuntimeProtocolErrorData = z.infer<typeof runtimeProtocolErrorDataSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
export type UiMessage = z.infer<typeof uiMessageSchema>;
export type OperationView = z.infer<typeof operationViewSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type ApprovalExplanation = z.infer<typeof approvalExplanationSchema>;
export type ActiveTurn = z.infer<typeof activeTurnSchema>;
export type ApprovalRequestParams = z.infer<typeof approvalRequestParamsSchema>;
export type ApprovalRequestResult = z.infer<typeof approvalRequestResultSchema>;
export type ApprovalResolution = z.infer<typeof approvalResolutionSchema>;
export type RuntimeServerRequestCancelParams = z.infer<
  typeof runtimeServerRequestCancelParamsSchema
>;

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

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export function isRuntimeMethod(value: string): value is RuntimeMethod {
  return Object.hasOwn(runtimeMethodSchemas, value);
}

export function parseRuntimeMethodParams<TMethod extends RuntimeMethod>(
  method: TMethod,
  value: unknown,
): RuntimeMethodParams<TMethod> {
  return runtimeMethodSchemas[method].params.parse(value) as RuntimeMethodParams<TMethod>;
}

export function parseRuntimeMethodResult<TMethod extends RuntimeMethod>(
  method: TMethod,
  value: unknown,
): RuntimeMethodResult<TMethod> {
  return runtimeMethodSchemas[method].result.parse(value) as RuntimeMethodResult<TMethod>;
}

export function isRuntimeServerRequestMethod(value: string): value is RuntimeServerRequestMethod {
  return Object.hasOwn(runtimeServerRequestSchemas, value);
}

export function parseRuntimeServerRequestParams<TMethod extends RuntimeServerRequestMethod>(
  method: TMethod,
  value: unknown,
): RuntimeServerRequestParams<TMethod> {
  return runtimeServerRequestSchemas[method].params.parse(
    value,
  ) as RuntimeServerRequestParams<TMethod>;
}

export function parseRuntimeServerRequestResult<TMethod extends RuntimeServerRequestMethod>(
  method: TMethod,
  value: unknown,
): RuntimeServerRequestResult<TMethod> {
  return runtimeServerRequestSchemas[method].result.parse(
    value,
  ) as RuntimeServerRequestResult<TMethod>;
}
