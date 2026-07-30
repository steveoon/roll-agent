import {
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_METHODS,
  getRuntimeProtocolCapabilities,
  parseRuntimeMethodParams,
  type ApprovalId,
  type ApprovalRequestParams,
  type ApprovalRequestResult,
  type InitializeResult,
  type JsonRpcId,
  type PendingApproval,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodInput,
  type RuntimeMethodParams,
  type RuntimeMethodResult,
  type RuntimeProtocolCapabilities,
} from "@roll-agent/protocol";
import type {
  RollNodeClient,
  RuntimeServerRequestContext,
  RuntimeServerRequestHandler,
} from "@roll-agent/client-node";
import { z } from "zod";
import {
  CompanionEventBuffer,
  type CompanionEventBufferOptions,
  type EventBufferReplay,
} from "./event-buffer.ts";
import { WorkspaceLeaseManager } from "./lease-manager.ts";
import {
  RELAY_REQUEST_METHODS,
  relayApprovalCandidateParamsSchema,
  type RelayApprovalCandidateInput,
  type RelayApprovalCandidateParams,
  type RelayApprovalCandidateResult,
  type RelayRequestMethod,
  type RelayRuntimeRequest,
} from "@roll-agent/relay-protocol";

export const LOCAL_APPROVAL_DECISIONS = ["allow", "deny", "require-local-confirmation"] as const;

export const localApprovalDecisionSchema = z.enum(LOCAL_APPROVAL_DECISIONS);

export type LocalApprovalDecision = z.infer<typeof localApprovalDecisionSchema>;

export interface LocalApprovalPolicyContext {
  readonly signal: AbortSignal;
}

export type LocalApprovalPolicy = (
  approval: PendingApproval,
  context: LocalApprovalPolicyContext,
) => LocalApprovalDecision | Promise<LocalApprovalDecision>;

export interface CompanionRuntimeClient {
  request<TMethod extends RuntimeMethod>(
    method: TMethod,
    input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>>;
  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
  getInitializationResult?(): Pick<InitializeResult, "protocolVersion">;
  close(): void;
  shutdown?(): Promise<unknown>;
}

export interface CompanionWorkspaceOptions extends CompanionEventBufferOptions {
  readonly client: CompanionRuntimeClient;
  readonly localApprovalPolicy: LocalApprovalPolicy;
  readonly approvalRequestBroker?: CompanionApprovalRequestBroker;
}

export class LocalApprovalDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalApprovalDeniedError";
  }
}

export class LocalConfirmationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConfirmationRequiredError";
  }
}

export class InvalidRelayRequestParamsError extends Error {
  readonly method: RelayRequestMethod;

  constructor(method: RelayRequestMethod) {
    super(`Invalid params for Relay method "${method}"`);
    this.name = "InvalidRelayRequestParamsError";
    this.method = method;
  }
}

function parseRelayRuntimeMethodParams<TMethod extends RuntimeMethod>(
  method: TMethod,
  input: unknown,
): RuntimeMethodParams<TMethod> {
  try {
    return parseRuntimeMethodParams(method, input);
  } catch {
    throw new InvalidRelayRequestParamsError(method);
  }
}

function parseRelayApprovalCandidateParams(input: unknown): RelayApprovalCandidateParams {
  const parsed = relayApprovalCandidateParamsSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidRelayRequestParamsError(RELAY_REQUEST_METHODS.approvalCandidate);
  }
  return parsed.data;
}

function parseLocalApprovalDecision(value: unknown): LocalApprovalDecision {
  const parsed = localApprovalDecisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new LocalApprovalDeniedError(
      "Local Companion policy returned an invalid approval decision",
    );
  }
  return parsed.data;
}

interface PendingCompanionApprovalRequest {
  readonly params: ApprovalRequestParams;
  readonly requestId: JsonRpcId;
  readonly signal: AbortSignal;
  readonly resolve: (result: ApprovalRequestResult) => void;
  readonly reject: (error: Error) => void;
  readonly releaseLease: () => void;
  activeApproveController: AbortController | undefined;
}

interface LegacyPendingApproval {
  readonly approval: PendingApproval;
  readonly controller: AbortController;
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(
    reason === undefined ? "Runtime cancelled the approval request" : String(reason),
  );
}

async function evaluateLocalApprovalPolicy(
  approval: PendingApproval,
  signal: AbortSignal,
  policy: LocalApprovalPolicy,
): Promise<LocalApprovalDecision> {
  if (signal.aborted) {
    throw toAbortError(signal.reason);
  }
  let rejectOnAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const abort = () => {
    rejectOnAbort(toAbortError(signal.reason));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const policyResult = Promise.resolve().then(() => {
      if (signal.aborted) {
        throw toAbortError(signal.reason);
      }
      return policy(approval, { signal });
    });
    let decision: unknown;
    try {
      decision = await Promise.race([policyResult, aborted]);
    } catch {
      if (signal.aborted) {
        throw toAbortError(signal.reason);
      }
      throw new Error("Local Companion policy failed");
    }
    return parseLocalApprovalDecision(decision);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class CompanionApprovalRequestBroker {
  readonly leases = new WorkspaceLeaseManager();
  readonly handle: RuntimeServerRequestHandler<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  > = (params, context) => this.handleApprovalRequest(params, context);

  private readonly pendingRequests = new Map<ApprovalId, PendingCompanionApprovalRequest>();
  private localApprovalPolicy: LocalApprovalPolicy | undefined;

  bindLocalApprovalPolicy(policy: LocalApprovalPolicy): () => void {
    if (this.localApprovalPolicy !== undefined) {
      throw new Error("Companion approval request broker is already bound to a workspace");
    }
    this.localApprovalPolicy = policy;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.localApprovalPolicy === policy) {
        this.localApprovalPolicy = undefined;
      }
    };
  }

  async submitCandidate(
    params: RelayApprovalCandidateParams,
  ): Promise<RelayApprovalCandidateResult> {
    const pending = this.pendingRequests.get(params.approvalId);
    if (pending === undefined) {
      throw new LocalApprovalDeniedError(`Approval "${params.approvalId}" is no longer pending`);
    }
    if (
      pending.params.threadId !== params.threadId ||
      pending.params.approval.turnId !== params.turnId
    ) {
      throw new LocalApprovalDeniedError(
        `Approval "${params.approvalId}" does not belong to the requested thread and turn`,
      );
    }

    if (params.decision === "reject") {
      pending.activeApproveController?.abort(
        new LocalApprovalDeniedError(
          `Approval "${params.approvalId}" approval candidate was superseded by rejection`,
        ),
      );
      this.assertStillPending(pending);
      this.resolvePending(pending, {
        decision: "reject",
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      });
      return { accepted: true };
    }

    if (pending.activeApproveController !== undefined) {
      throw new LocalApprovalDeniedError(
        `Approval "${params.approvalId}" already has an approval candidate in progress`,
      );
    }

    const candidateController = new AbortController();
    pending.activeApproveController = candidateController;
    try {
      const policy = this.localApprovalPolicy;
      if (policy === undefined) {
        throw new LocalApprovalDeniedError(
          "Companion approval request broker is not bound to a local policy",
        );
      }
      const localDecision = await evaluateLocalApprovalPolicy(
        pending.params.approval,
        AbortSignal.any([pending.signal, candidateController.signal]),
        policy,
      );
      this.assertStillPending(pending);
      if (localDecision === "deny") {
        this.resolvePending(pending, {
          decision: "reject",
          reason: "Local Companion policy denied remote approval",
        });
        throw new LocalApprovalDeniedError("Local Companion policy denied remote approval");
      }
      if (localDecision === "require-local-confirmation") {
        throw new LocalConfirmationRequiredError(
          "Local confirmation is required before this approval can continue",
        );
      }

      this.assertStillPending(pending);
      this.resolvePending(pending, { decision: "approve" });
      return { accepted: true };
    } catch (error: unknown) {
      if (
        !(error instanceof LocalConfirmationRequiredError) &&
        this.pendingRequests.get(params.approvalId) === pending
      ) {
        this.rejectPending(
          pending,
          error instanceof Error
            ? error
            : new LocalApprovalDeniedError("Local Companion policy failed"),
        );
      }
      throw error;
    } finally {
      if (pending.activeApproveController === candidateController) {
        pending.activeApproveController = undefined;
      }
    }
  }

  private handleApprovalRequest(
    params: ApprovalRequestParams,
    context: RuntimeServerRequestContext,
  ): Promise<ApprovalRequestResult> {
    if (context.signal.aborted) {
      return Promise.reject(toAbortError(context.signal.reason));
    }
    const existing = this.pendingRequests.get(params.approval.id);
    if (existing !== undefined) {
      return Promise.reject(
        new Error(
          `Approval "${params.approval.id}" is already pending for Runtime request ` +
            JSON.stringify(existing.requestId),
        ),
      );
    }

    let resolveRequest: (result: ApprovalRequestResult) => void = () => {};
    let rejectRequest: (error: Error) => void = () => {};
    const result = new Promise<ApprovalRequestResult>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const pending: PendingCompanionApprovalRequest = {
      params,
      requestId: context.requestId,
      signal: context.signal,
      resolve: resolveRequest,
      reject: rejectRequest,
      releaseLease: this.leases.acquire({ kind: "approval", id: params.approval.id }),
      activeApproveController: undefined,
    };
    const abort = () => {
      this.rejectPending(pending, toAbortError(context.signal.reason));
    };
    this.pendingRequests.set(params.approval.id, pending);
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) {
      abort();
    }
    return result.finally(() => {
      context.signal.removeEventListener("abort", abort);
    });
  }

  private assertStillPending(pending: PendingCompanionApprovalRequest): void {
    if (this.pendingRequests.get(pending.params.approval.id) !== pending) {
      throw new LocalApprovalDeniedError(
        `Approval "${pending.params.approval.id}" is no longer pending`,
      );
    }
  }

  private resolvePending(
    pending: PendingCompanionApprovalRequest,
    result: ApprovalRequestResult,
  ): void {
    this.pendingRequests.delete(pending.params.approval.id);
    pending.releaseLease();
    pending.resolve(result);
  }

  private rejectPending(pending: PendingCompanionApprovalRequest, error: Error): void {
    if (this.pendingRequests.get(pending.params.approval.id) !== pending) {
      return;
    }
    this.pendingRequests.delete(pending.params.approval.id);
    pending.releaseLease();
    pending.reject(error);
  }
}

export class CompanionWorkspace {
  readonly leases: WorkspaceLeaseManager;
  readonly events: CompanionEventBuffer;

  private readonly client: CompanionRuntimeClient;
  private readonly localApprovalPolicy: LocalApprovalPolicy;
  private readonly protocolCapabilities: RuntimeProtocolCapabilities;
  private readonly approvalRequestBroker: CompanionApprovalRequestBroker | undefined;
  private readonly approvals = new Map<string, LegacyPendingApproval>();
  private readonly eventListeners = new Set<
    (event: { readonly relaySequence: number; readonly event: RuntimeEventEnvelope }) => void
  >();
  private readonly releaseClientSubscription: () => void;
  private readonly releaseApprovalPolicyBinding: (() => void) | undefined;
  private closed = false;

  constructor(options: CompanionWorkspaceOptions) {
    this.client = options.client;
    this.localApprovalPolicy = options.localApprovalPolicy;
    this.protocolCapabilities = getRuntimeProtocolCapabilities(
      this.client.getInitializationResult?.().protocolVersion ?? "1.0",
    );
    this.approvalRequestBroker = options.approvalRequestBroker;
    if (this.protocolCapabilities.serverRequests && this.approvalRequestBroker === undefined) {
      throw new Error(
        "The negotiated Runtime Protocol requires a CompanionApprovalRequestBroker registered during client initialization",
      );
    }
    this.events = new CompanionEventBuffer({
      ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });
    this.leases = this.approvalRequestBroker?.leases ?? new WorkspaceLeaseManager();
    const releaseApprovalPolicyBinding = this.approvalRequestBroker?.bindLocalApprovalPolicy(
      this.localApprovalPolicy,
    );
    try {
      this.releaseClientSubscription = this.client.onEvent((event) => this.handleEvent(event));
    } catch (error: unknown) {
      releaseApprovalPolicyBinding?.();
      throw error;
    }
    this.releaseApprovalPolicyBinding = releaseApprovalPolicyBinding;
  }

  attachBrowser(clientId: string): () => void {
    return this.leases.acquire({ kind: "client", id: clientId });
  }

  detachBrowser(clientId: string): boolean {
    return this.leases.releaseClient(clientId);
  }

  acquireBackgroundShellLease(sessionId: string): () => void {
    return this.leases.acquire({ kind: "shell-session", id: sessionId });
  }

  onBufferedEvent(
    listener: (entry: {
      readonly relaySequence: number;
      readonly event: RuntimeEventEnvelope;
    }) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  replay(afterRelaySequence = -1): EventBufferReplay {
    return this.events.replay(afterRelaySequence);
  }

  acknowledge(throughRelaySequence: number): void {
    this.events.acknowledge(throughRelaySequence);
  }

  async startTurn(
    input: RuntimeMethodInput<"turn.start">,
  ): Promise<RuntimeMethodResult<"turn.start">> {
    const params = parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, input);
    const releaseTurnLease = this.leases.acquire({ kind: "turn", id: params.turnId });
    try {
      return await this.client.request(RUNTIME_METHODS.turnStart, params);
    } catch (error: unknown) {
      releaseTurnLease();
      throw error;
    }
  }

  async respondApproval(
    input: RuntimeMethodInput<"approval.respond">,
  ): Promise<RuntimeMethodResult<"approval.respond">> {
    const params = parseRuntimeMethodParams(RUNTIME_METHODS.approvalRespond, input);
    if (!this.protocolCapabilities.clientApprovalResponses) {
      throw new LocalApprovalDeniedError(
        "The negotiated Runtime Protocol must use the Relay approval.candidate method",
      );
    }

    const pending = this.approvals.get(params.approvalId);
    if (pending === undefined) {
      throw new LocalApprovalDeniedError(`Approval "${params.approvalId}" is no longer pending`);
    }
    if (params.decision === "approve") {
      const localDecision = await evaluateLocalApprovalPolicy(
        pending.approval,
        pending.controller.signal,
        this.localApprovalPolicy,
      );
      if (pending.controller.signal.aborted || this.approvals.get(params.approvalId) !== pending) {
        throw toAbortError(pending.controller.signal.reason);
      }
      if (localDecision === "deny") {
        throw new LocalApprovalDeniedError("Local Companion policy denied remote approval");
      }
      if (localDecision === "require-local-confirmation") {
        throw new LocalConfirmationRequiredError(
          "Local confirmation is required before this approval can continue",
        );
      }
    }
    const result = await this.client.request(RUNTIME_METHODS.approvalRespond, params);
    if (this.approvals.get(params.approvalId) === pending) {
      pending.controller.abort(
        new LocalApprovalDeniedError(
          `Approval "${params.approvalId}" was resolved by another response`,
        ),
      );
      this.approvals.delete(params.approvalId);
      this.leases.release({ kind: "approval", id: params.approvalId });
    }
    return result;
  }

  async submitApprovalCandidate(
    input: RelayApprovalCandidateInput,
  ): Promise<RelayApprovalCandidateResult> {
    const params = parseRelayApprovalCandidateParams(input);
    if (!this.protocolCapabilities.serverRequests) {
      throw new LocalApprovalDeniedError(
        "Relay approval.candidate requires Runtime server-request capability",
      );
    }
    const broker = this.approvalRequestBroker;
    if (broker === undefined) {
      throw new LocalApprovalDeniedError("Runtime server-request approval broker is unavailable");
    }
    return broker.submitCandidate(params);
  }

  async handleRemoteRequest(request: RelayRuntimeRequest): Promise<unknown> {
    switch (request.method) {
      case RELAY_REQUEST_METHODS.approvalCandidate:
        return this.submitApprovalCandidate(parseRelayApprovalCandidateParams(request.params));
      case RUNTIME_METHODS.initialize:
        throw new LocalApprovalDeniedError(
          "initialize is owned by the local Companion and cannot be relayed",
        );
      case RUNTIME_METHODS.threadList:
        return this.client.request(
          RUNTIME_METHODS.threadList,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadList, request.params),
        );
      case RUNTIME_METHODS.threadCreate:
        return this.client.request(
          RUNTIME_METHODS.threadCreate,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadCreate, request.params),
        );
      case RUNTIME_METHODS.threadOpen:
        return this.client.request(
          RUNTIME_METHODS.threadOpen,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadOpen, request.params),
        );
      case RUNTIME_METHODS.threadSnapshot:
        return this.client.request(
          RUNTIME_METHODS.threadSnapshot,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadSnapshot, request.params),
        );
      case RUNTIME_METHODS.threadRename:
        return this.client.request(
          RUNTIME_METHODS.threadRename,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadRename, request.params),
        );
      case RUNTIME_METHODS.threadDelete:
        return this.client.request(
          RUNTIME_METHODS.threadDelete,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadDelete, request.params),
        );
      case RUNTIME_METHODS.threadDetach:
        return this.client.request(
          RUNTIME_METHODS.threadDetach,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadDetach, request.params),
        );
      case RUNTIME_METHODS.threadCapabilities:
        return this.client.request(
          RUNTIME_METHODS.threadCapabilities,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.threadCapabilities, request.params),
        );
      case RUNTIME_METHODS.turnStart:
        return this.startTurn(
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.turnStart, request.params),
        );
      case RUNTIME_METHODS.turnCancel:
        return this.client.request(
          RUNTIME_METHODS.turnCancel,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.turnCancel, request.params),
        );
      case RUNTIME_METHODS.approvalRespond:
        return this.respondApproval(
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.approvalRespond, request.params),
        );
      case RUNTIME_METHODS.operationGet:
        return this.client.request(
          RUNTIME_METHODS.operationGet,
          parseRelayRuntimeMethodParams(RUNTIME_METHODS.operationGet, request.params),
        );
    }
  }

  async closeIfIdle(): Promise<boolean> {
    if (this.closed) {
      return true;
    }
    if (!this.leases.canStopRuntime()) {
      return false;
    }
    this.closed = true;
    try {
      this.releaseClientSubscription();
    } finally {
      this.releaseApprovalPolicyBinding?.();
    }
    if (this.client.shutdown === undefined) {
      this.client.close();
    } else {
      await this.client.shutdown();
    }
    return true;
  }

  private handleEvent(event: RuntimeEventEnvelope): void {
    this.updateLeases(event);
    const buffered = this.events.append(event);
    for (const listener of this.eventListeners) {
      try {
        listener(buffered);
      } catch {
        // Relay/event observers must not block later subscribers or workspace state updates.
      }
    }
  }

  private updateLeases(event: RuntimeEventEnvelope): void {
    if (
      event.turnId !== undefined &&
      (event.event.type === "turn.completed" ||
        event.event.type === "turn.cancelled" ||
        event.event.type === "turn.failed")
    ) {
      this.leases.release({ kind: "turn", id: event.turnId });
      if (this.protocolCapabilities.clientApprovalResponses) {
        for (const [approvalId, pending] of this.approvals) {
          if (pending.approval.turnId === event.turnId) {
            this.approvals.delete(approvalId);
            pending.controller.abort(new Error(`Turn ended with ${event.event.type}`));
            this.leases.release({ kind: "approval", id: approvalId });
          }
        }
      }
      return;
    }
    if (
      this.protocolCapabilities.clientApprovalResponses &&
      event.event.type === "approval.required"
    ) {
      const approval = event.event.approval;
      const previous = this.approvals.get(approval.id);
      previous?.controller.abort(new Error(`Approval "${approval.id}" was superseded`));
      this.approvals.set(approval.id, {
        approval,
        controller: new AbortController(),
      });
      this.leases.acquire({ kind: "approval", id: approval.id });
    }
  }
}

export function isRollNodeClient(client: CompanionRuntimeClient): client is RollNodeClient {
  return "getOutcomeUnknownTurnIds" in client;
}
