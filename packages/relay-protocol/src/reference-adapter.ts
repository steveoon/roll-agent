import {
  RELAY_REQUEST_METHODS_V11,
  relayInteractionCancelledSchemaV11,
  relayInteractionCandidateParamsSchemaV11,
  relayInteractionRequestSchemaV11,
  relayInteractionResolvedSchemaV11,
  relayRequestIdSchema,
  relayRuntimeRequestSchemaV11,
  parseRelayInteractionCandidateForRequestV11,
  type InteractionId,
  type RelayInteractionCancelledV11,
  type RelayInteractionRequestV11,
  type RelayInteractionResolvedV11,
  type RelayRequestId,
  type RelayRuntimeRequestV11,
  type WorkspaceId,
} from "./index.ts";

export const RELAY_REFERENCE_ADAPTER_ERROR_CODES = {
  protocolVersionUnsupported: "RELAY_REFERENCE_PROTOCOL_VERSION_UNSUPPORTED",
  invalidFrame: "RELAY_REFERENCE_INVALID_FRAME",
  interactionConflict: "RELAY_REFERENCE_INTERACTION_CONFLICT",
  interactionNotPending: "RELAY_REFERENCE_INTERACTION_NOT_PENDING",
  interactionTerminated: "RELAY_REFERENCE_INTERACTION_TERMINATED",
  interactionIdentityMismatch: "RELAY_REFERENCE_INTERACTION_IDENTITY_MISMATCH",
  candidateMethodMismatch: "RELAY_REFERENCE_CANDIDATE_METHOD_MISMATCH",
  requestIdUnavailable: "RELAY_REFERENCE_REQUEST_ID_UNAVAILABLE",
} as const;

export type RelayReferenceAdapterErrorCode =
  (typeof RELAY_REFERENCE_ADAPTER_ERROR_CODES)[keyof typeof RELAY_REFERENCE_ADAPTER_ERROR_CODES];

export class RelayReferenceAdapterError extends Error {
  readonly code: RelayReferenceAdapterErrorCode;

  constructor(code: RelayReferenceAdapterErrorCode, message: string) {
    super(message);
    this.name = "RelayReferenceAdapterError";
    this.code = code;
  }
}

export interface RelayBrowserReferenceAdapterOptions {
  /** Wire version is explicit so a legacy 1.0 connection cannot opt in accidentally. */
  readonly protocolVersion: "1.1";
  /** The embedding host owns Relay request ID allocation. */
  readonly createRequestId?: () => RelayRequestId;
}

export type RelayInteractionMethodV11 = RelayInteractionRequestV11["method"];

export interface RelayInteractionCandidateInputV11 {
  readonly workspaceId: WorkspaceId;
  readonly interactionId: InteractionId;
  readonly method: RelayInteractionMethodV11;
  readonly candidate: unknown;
}

export type RelayReferenceAdapterReceiveResultV11 =
  | {
      readonly status: "pending" | "duplicate";
      readonly request: RelayInteractionRequestV11;
    }
  | {
      readonly status: "resolved";
      readonly request: RelayInteractionRequestV11;
      readonly frame: RelayInteractionResolvedV11;
    }
  | {
      readonly status: "cancelled";
      readonly request: RelayInteractionRequestV11;
      readonly frame: RelayInteractionCancelledV11;
    };

type RelayInteractionTerminalV11 = RelayInteractionResolvedV11 | RelayInteractionCancelledV11;

function pendingKey(workspaceId: WorkspaceId, interactionId: InteractionId): string {
  return `${workspaceId}:${interactionId}`;
}

function hasSameInteractionIdentity(
  request: RelayInteractionRequestV11,
  terminal: RelayInteractionTerminalV11,
): boolean {
  return (
    request.workspaceId === terminal.workspaceId &&
    request.interactionId === terminal.interactionId &&
    request.threadId === terminal.threadId &&
    request.turnId === terminal.turnId &&
    request.method === terminal.method
  );
}

function parseInteractionFrame(
  value: unknown,
): RelayInteractionRequestV11 | RelayInteractionResolvedV11 | RelayInteractionCancelledV11 {
  const request = relayInteractionRequestSchemaV11.safeParse(value);
  if (request.success) {
    return request.data;
  }
  const resolved = relayInteractionResolvedSchemaV11.safeParse(value);
  if (resolved.success) {
    return resolved.data;
  }
  const cancelled = relayInteractionCancelledSchemaV11.safeParse(value);
  if (cancelled.success) {
    return cancelled.data;
  }
  throw new RelayReferenceAdapterError(
    RELAY_REFERENCE_ADAPTER_ERROR_CODES.invalidFrame,
    "Expected a Relay Wire 1.1 interaction request, resolved, or cancelled frame",
  );
}

function createBrowserRequestId(): RelayRequestId {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new RelayReferenceAdapterError(
      RELAY_REFERENCE_ADAPTER_ERROR_CODES.requestIdUnavailable,
      "Relay candidate request IDs require crypto.randomUUID or an injected createRequestId",
    );
  }
  return relayRequestIdSchema.parse(globalThis.crypto.randomUUID());
}

/**
 * Browser-safe, in-memory correlation for Relay Wire 1.1 interaction frames.
 * Authentication, responder policy, delivery retries, and persistence remain host responsibilities.
 */
export class RelayBrowserReferenceAdapter {
  private readonly createRequestId: () => RelayRequestId;
  private readonly pending = new Map<string, RelayInteractionRequestV11>();
  private readonly terminated = new Set<string>();

  constructor(options: RelayBrowserReferenceAdapterOptions) {
    if (options.protocolVersion !== "1.1") {
      throw new RelayReferenceAdapterError(
        RELAY_REFERENCE_ADAPTER_ERROR_CODES.protocolVersionUnsupported,
        `Relay reference adapter requires Wire 1.1, received ${JSON.stringify(options.protocolVersion)}`,
      );
    }
    this.createRequestId = options.createRequestId ?? createBrowserRequestId;
  }

  receive(value: unknown): RelayReferenceAdapterReceiveResultV11 {
    const frame = parseInteractionFrame(value);
    if (frame.type === "interaction.request") {
      const key = pendingKey(frame.workspaceId, frame.interactionId);
      if (this.terminated.has(key)) {
        throw new RelayReferenceAdapterError(
          RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionTerminated,
          `Interaction ${frame.interactionId} has already terminated in this workspace`,
        );
      }
      const existing = this.pending.get(key);
      if (existing === undefined) {
        this.pending.set(key, frame);
        return { status: "pending", request: frame };
      }
      if (JSON.stringify(existing) === JSON.stringify(frame)) {
        return { status: "duplicate", request: existing };
      }
      throw new RelayReferenceAdapterError(
        RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionConflict,
        `Interaction ${frame.interactionId} is already pending with different metadata`,
      );
    }

    const key = pendingKey(frame.workspaceId, frame.interactionId);
    const request = this.pending.get(key);
    if (request === undefined) {
      throw new RelayReferenceAdapterError(
        RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionNotPending,
        `Interaction ${frame.interactionId} is not pending in this workspace`,
      );
    }
    if (!hasSameInteractionIdentity(request, frame)) {
      throw new RelayReferenceAdapterError(
        RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionIdentityMismatch,
        `Interaction ${frame.interactionId} terminal frame does not match its pending request`,
      );
    }

    this.pending.delete(key);
    this.terminated.add(key);
    return frame.type === "interaction.resolved"
      ? { status: "resolved", request, frame }
      : { status: "cancelled", request, frame };
  }

  createCandidate(input: RelayInteractionCandidateInputV11): RelayRuntimeRequestV11 {
    const request = this.pending.get(pendingKey(input.workspaceId, input.interactionId));
    if (request === undefined) {
      throw new RelayReferenceAdapterError(
        RELAY_REFERENCE_ADAPTER_ERROR_CODES.interactionNotPending,
        `Interaction ${input.interactionId} is not pending in this workspace`,
      );
    }
    if (request.method !== input.method) {
      throw new RelayReferenceAdapterError(
        RELAY_REFERENCE_ADAPTER_ERROR_CODES.candidateMethodMismatch,
        `Candidate method ${input.method} does not match pending method ${request.method}`,
      );
    }

    const params = relayInteractionCandidateParamsSchemaV11.parse(
      parseRelayInteractionCandidateForRequestV11(request, input.candidate),
    );
    return relayRuntimeRequestSchemaV11.parse({
      type: "runtime.request",
      requestId: this.createRequestId(),
      workspaceId: request.workspaceId,
      method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
      params,
    });
  }

  getPending(
    workspaceId: WorkspaceId,
    interactionId: InteractionId,
  ): RelayInteractionRequestV11 | undefined {
    return this.pending.get(pendingKey(workspaceId, interactionId));
  }

  listPending(): readonly RelayInteractionRequestV11[] {
    return [...this.pending.values()];
  }
}

export function createRelayBrowserReferenceAdapter(
  options: RelayBrowserReferenceAdapterOptions,
): RelayBrowserReferenceAdapter {
  return new RelayBrowserReferenceAdapter(options);
}
