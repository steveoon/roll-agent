import { randomUUID } from "node:crypto";
import {
  RUNTIME_SERVER_REQUEST_METHODS,
  approvalRequestParamsV11Schema,
  approvalRequestParamsV12Schema,
  approvalRequestResultSchema,
  getApprovalExplanation,
  interactionIdSchema,
  normalizeUserInputResult,
  userInputFormSchema,
  userInputRequestParamsV12Schema,
  userInputResultSchema,
  type ApprovalId,
  type ApprovalRequestParamsV11,
  type ApprovalRequestParamsV12,
  type ApprovalRequestResult,
  type InteractionId,
  type PendingApproval,
  type ThreadId,
  type TurnId,
  type UserInputRequestParamsV12,
  type UserInputResult,
} from "@roll-agent/protocol";
import type {
  RuntimeServerRequestContext,
  RuntimeServerRequestHandler,
  RuntimeServerRequestHandlers,
} from "@roll-agent/client-node";
import {
  RELAY_INTERACTION_METHODS_V11,
  RELAY_MESSAGE_TYPES_V11,
  relayApprovalCandidateParamsSchema,
  relayInteractionCandidateParamsSchemaV11,
  relayRequestIdSchema,
  workspaceIdSchema,
  type RelayApprovalCandidateParams,
  type RelayApprovalCandidateResult,
  type RelayInteractionCandidateParamsV11,
  type RelayInteractionCandidateResultV11,
  type RelayInteractionCancelledV11,
  type RelayInteractionMethodV11,
  type RelayInteractionRequestV11,
  type RelayInteractionResolvedV11,
  type RelayRequestId,
  type WorkspaceId,
} from "@roll-agent/relay-protocol";
import { z } from "zod/v4";
import type { LocalApprovalPolicy } from "./companion-workspace.ts";
import { WorkspaceLeaseManager } from "./lease-manager.ts";

const DEFAULT_LEGACY_APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type RelaySequenceFields = "workspaceId" | "relaySequence";
type WithoutRelaySequence<T> = T extends unknown ? Omit<T, RelaySequenceFields> : never;

/**
 * A safe Relay Wire 1.1 interaction frame before a workspace sequence is assigned.
 *
 * The union is deliberately derived from the public Relay contract. Runtime JSON-RPC ids,
 * approval previews, tool input/output, and full interaction results cannot be represented here.
 */
export type CompanionInteractionFrameDraftV11 =
  | WithoutRelaySequence<RelayInteractionRequestV11>
  | WithoutRelaySequence<RelayInteractionResolvedV11>
  | WithoutRelaySequence<RelayInteractionCancelledV11>;

type CompanionInteractionRequestFrameDraftV11 = Extract<
  CompanionInteractionFrameDraftV11,
  { readonly type: "interaction.request" }
>;

export interface CompanionInteractionWorkspaceBinding {
  readonly workspaceId: WorkspaceId;
  readonly localApprovalPolicy: LocalApprovalPolicy;
  readonly publish: (frame: CompanionInteractionFrameDraftV11) => void;
}

export interface RemoteInteractionResponderPolicyInput {
  readonly workspaceId: WorkspaceId;
  readonly requestId: RelayRequestId;
  readonly interactionId: InteractionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly method: RelayInteractionMethodV11;
  readonly responderContext: unknown;
  /** Aborted when the Relay connection generation that supplied this candidate becomes stale. */
  readonly signal: AbortSignal;
}

export type RemoteInteractionResponderPolicy = (
  input: RemoteInteractionResponderPolicyInput,
) => boolean | Promise<boolean>;

export interface RemoteInteractionCandidateContext {
  readonly workspaceId: WorkspaceId;
  readonly requestId: RelayRequestId;
  /** Signal owned by one Relay connection generation, not by the logical Runtime interaction. */
  readonly signal: AbortSignal;
  readonly responderPolicy: RemoteInteractionResponderPolicy;
  readonly responderContext: unknown;
}

export interface CompanionInteractionBrokerOptions {
  /** Runtime 1.1 does not carry a deadline; this local bound is used for its Approval facade. */
  readonly legacyApprovalTimeoutMs?: number;
  readonly now?: () => number;
  readonly createInteractionId?: () => InteractionId;
}

type RuntimeInteractionResult = ApprovalRequestResult | UserInputResult;
type RuntimeApprovalParams = ApprovalRequestParamsV11 | ApprovalRequestParamsV12;

interface PendingInteractionBase {
  readonly interactionId: InteractionId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly expiresAt: string;
  readonly runtimeSignal: AbortSignal;
  readonly resolve: (result: RuntimeInteractionResult) => void;
  readonly reject: (error: Error) => void;
  readonly removeRuntimeAbortListener: () => void;
  readonly releaseLease: () => void;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  requestPublished: boolean;
  activeCandidate: CandidateAttempt | undefined;
}

interface PendingApprovalInteraction extends PendingInteractionBase {
  readonly method: typeof RELAY_INTERACTION_METHODS_V11.approvalRequest;
  readonly params: RuntimeApprovalParams;
  readonly approval: PendingApproval;
  readonly approvalId: ApprovalId;
}

interface PendingUserInputInteraction extends PendingInteractionBase {
  readonly method: typeof RELAY_INTERACTION_METHODS_V11.userInputRequest;
  readonly params: UserInputRequestParamsV12;
}

type PendingInteraction = PendingApprovalInteraction | PendingUserInputInteraction;

interface CandidateAttempt {
  readonly key: string;
  readonly fingerprint: string;
  readonly controller: AbortController;
  readonly generationSignal: AbortSignal | undefined;
  readonly result: Promise<RelayInteractionCandidateResultV11>;
}

interface BoundWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly localApprovalPolicy: LocalApprovalPolicy;
  readonly publish: (frame: CompanionInteractionFrameDraftV11) => void;
}

const remoteCandidateIdentitySchema = z
  .object({
    interactionId: interactionIdSchema,
    threadId: z.string().uuid().brand<"ThreadId">(),
    turnId: z.string().uuid().brand<"TurnId">(),
    method: z.enum([
      RELAY_INTERACTION_METHODS_V11.approvalRequest,
      RELAY_INTERACTION_METHODS_V11.userInputRequest,
    ]),
  })
  .passthrough()
  .readonly();

function asError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(reason === undefined ? fallback : String(reason));
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function localApprovalDenied(message: string): Error {
  return namedError("LocalApprovalDeniedError", message);
}

function localConfirmationRequired(message: string): Error {
  return namedError("LocalConfirmationRequiredError", message);
}

function responderDenied(message: string): Error {
  return namedError("RemoteInteractionResponderDeniedError", message);
}

function candidateAborted(reason: unknown): Error {
  const error = asError(reason, "The Relay connection generation is no longer active");
  if (error.name === "Error") {
    error.name = "RemoteInteractionCandidateAbortedError";
  }
  return error;
}

function interactionCancelled(reason: unknown, fallback: string): Error {
  const error = asError(reason, fallback);
  if (error.name === "Error") {
    error.name = "CompanionInteractionCancelledError";
  }
  return error;
}

function parseLocalApprovalDecision(
  value: unknown,
): "allow" | "deny" | "require-local-confirmation" {
  if (value === "allow" || value === "deny" || value === "require-local-confirmation") {
    return value;
  }
  throw localApprovalDenied("Local Companion policy returned an invalid approval decision");
}

async function raceWithAbort<T>(
  work: () => T | Promise<T>,
  signal: AbortSignal,
  fallback: string,
): Promise<T> {
  if (signal.aborted) {
    throw asError(signal.reason, fallback);
  }
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    aborted.reject(asError(signal.reason, fallback));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(work), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function candidateFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "unserializable";
  }
}

function isApprovalParamsV12(
  params: ApprovalRequestParamsV11 | ApprovalRequestParamsV12,
): params is ApprovalRequestParamsV12 {
  return "interactionId" in params;
}

/**
 * Owns Runtime server-request interactions while exposing only safe Relay Wire projections.
 * One instance may be bound to one workspace for its entire active lifetime.
 */
export class CompanionInteractionBroker {
  readonly leases = new WorkspaceLeaseManager();

  readonly handleApprovalRequest: RuntimeServerRequestHandler<
    typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  > = (params, context) => this.registerApproval(params, context);

  readonly handleUserInputRequest: RuntimeServerRequestHandler<
    typeof RUNTIME_SERVER_REQUEST_METHODS.userInputRequest
  > = (params, context) => this.registerUserInput(params, context);

  private readonly pending = new Map<InteractionId, PendingInteraction>();
  private readonly approvalInteractions = new Map<ApprovalId, InteractionId>();
  private readonly legacyApprovalTimeoutMs: number;
  private readonly now: () => number;
  private readonly createInteractionId: () => InteractionId;
  private workspace: BoundWorkspace | undefined;
  private closed = false;

  constructor(options: CompanionInteractionBrokerOptions = {}) {
    const legacyApprovalTimeoutMs =
      options.legacyApprovalTimeoutMs ?? DEFAULT_LEGACY_APPROVAL_TIMEOUT_MS;
    if (!Number.isSafeInteger(legacyApprovalTimeoutMs) || legacyApprovalTimeoutMs <= 0) {
      throw new Error("legacyApprovalTimeoutMs must be a positive safe integer");
    }
    this.legacyApprovalTimeoutMs = legacyApprovalTimeoutMs;
    this.now = options.now ?? Date.now;
    this.createInteractionId =
      options.createInteractionId ?? (() => interactionIdSchema.parse(randomUUID()));
  }

  bindWorkspace(binding: CompanionInteractionWorkspaceBinding): () => void {
    if (this.closed) {
      throw new Error("Companion interaction broker is closed");
    }
    if (this.workspace !== undefined) {
      throw new Error("Companion interaction broker is already bound to a workspace");
    }
    const workspace: BoundWorkspace = {
      workspaceId: workspaceIdSchema.parse(binding.workspaceId),
      localApprovalPolicy: binding.localApprovalPolicy,
      publish: binding.publish,
    };
    if (
      typeof workspace.localApprovalPolicy !== "function" ||
      typeof workspace.publish !== "function"
    ) {
      throw new TypeError("Companion workspace binding requires policy and publish functions");
    }
    this.workspace = workspace;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.workspace !== workspace) {
        return;
      }
      const error = interactionCancelled(
        undefined,
        "Companion interaction workspace binding was released",
      );
      this.cancelAll(error);
      this.workspace = undefined;
    };
  }

  async submitCandidate(
    input: RelayInteractionCandidateParamsV11,
    context: RemoteInteractionCandidateContext,
  ): Promise<RelayInteractionCandidateResultV11> {
    const identity = remoteCandidateIdentitySchema.parse(input);
    const workspace = this.requireWorkspace();
    const contextWorkspaceId = workspaceIdSchema.parse(context.workspaceId);
    const requestId = relayRequestIdSchema.parse(context.requestId);
    if (contextWorkspaceId !== workspace.workspaceId) {
      throw responderDenied("Remote interaction candidate belongs to another workspace");
    }
    const pending = this.pending.get(identity.interactionId);
    this.assertCandidateIdentity(pending, identity);
    if (context.signal.aborted) {
      throw candidateAborted(context.signal.reason);
    }
    const fingerprint = candidateFingerprint(input);
    let active = pending.activeCandidate;
    if (active?.generationSignal?.aborted === true) {
      active.controller.abort(candidateAborted(active.generationSignal.reason));
      if (pending.activeCandidate === active) {
        pending.activeCandidate = undefined;
      }
      active = undefined;
    }
    if (active !== undefined && active.key === requestId) {
      if (active.fingerprint !== fingerprint) {
        throw responderDenied(`Relay request "${requestId}" conflicts with its active candidate`);
      }
      return active.result;
    }

    const process = async (
      attemptSignal?: AbortSignal,
    ): Promise<RelayInteractionCandidateResultV11> => {
      await this.authorizeResponder(pending, context, requestId, attemptSignal);
      const params = relayInteractionCandidateParamsSchemaV11.parse(input);
      this.assertStillPending(pending);
      if (
        pending.activeCandidate !== undefined &&
        pending.activeCandidate.key !== requestId &&
        !(
          params.method === RELAY_INTERACTION_METHODS_V11.approvalRequest &&
          params.candidate.decision === "reject"
        )
      ) {
        throw responderDenied(
          `Interaction "${pending.interactionId}" already has a candidate in progress`,
        );
      }
      if (params.method === RELAY_INTERACTION_METHODS_V11.userInputRequest) {
        if (pending.method !== params.method) {
          throw responderDenied("Remote interaction method no longer matches the pending request");
        }
        const normalized = normalizeUserInputResult(pending.params, params.candidate);
        this.finishResolved(pending, userInputResultSchema.parse(normalized));
        return { accepted: true };
      }
      if (pending.method !== params.method) {
        throw responderDenied("Remote interaction method no longer matches the pending request");
      }
      if (params.candidate.decision === "reject") {
        pending.activeCandidate?.controller.abort(
          localApprovalDenied("A remote rejection superseded the approval candidate"),
        );
        this.assertStillPending(pending);
        this.finishResolved(pending, approvalRequestResultSchema.parse(params.candidate));
        return { accepted: true };
      }
      return this.approveCandidate(pending, params.candidate, context.signal);
    };

    if (active !== undefined) {
      // A separately authorized rejection is allowed to supersede an in-flight approval attempt.
      return process(active.controller.signal);
    }
    const controller = new AbortController();
    const result = process(controller.signal);
    const attempt: CandidateAttempt = {
      key: requestId,
      fingerprint,
      controller,
      generationSignal: context.signal,
      result,
    };
    pending.activeCandidate = attempt;
    result.then(
      () => this.clearCandidateAttempt(pending, attempt),
      () => this.clearCandidateAttempt(pending, attempt),
    );
    return result;
  }

  async submitLegacyApprovalCandidate(
    input: RelayApprovalCandidateParams,
  ): Promise<RelayApprovalCandidateResult> {
    const params = relayApprovalCandidateParamsSchema.parse(input);
    const interactionId = this.approvalInteractions.get(params.approvalId);
    const pending = interactionId === undefined ? undefined : this.pending.get(interactionId);
    if (pending === undefined || pending.method !== RELAY_INTERACTION_METHODS_V11.approvalRequest) {
      throw localApprovalDenied(`Approval "${params.approvalId}" is no longer pending`);
    }
    if (pending.threadId !== params.threadId || pending.turnId !== params.turnId) {
      throw localApprovalDenied(
        `Approval "${params.approvalId}" does not belong to the requested thread and turn`,
      );
    }
    if (params.decision === "reject") {
      pending.activeCandidate?.controller.abort(
        localApprovalDenied("A legacy rejection superseded the approval candidate"),
      );
      this.assertStillPending(pending);
      this.finishResolved(
        pending,
        approvalRequestResultSchema.parse({
          decision: "reject",
          ...(params.reason === undefined ? {} : { reason: params.reason }),
        }),
      );
      return { accepted: true };
    }
    if (pending.activeCandidate !== undefined) {
      throw localApprovalDenied(
        `Approval "${params.approvalId}" already has a candidate in progress`,
      );
    }
    const controller = new AbortController();
    const result = this.approveCandidate(pending, { decision: "approve" }, controller.signal);
    const relayResult = result.then(() => ({ accepted: true }) as const);
    const attempt: CandidateAttempt = {
      key: `legacy:${params.approvalId}`,
      fingerprint: candidateFingerprint(params),
      controller,
      generationSignal: undefined,
      result: relayResult,
    };
    pending.activeCandidate = attempt;
    relayResult.then(
      () => this.clearCandidateAttempt(pending, attempt),
      () => this.clearCandidateAttempt(pending, attempt),
    );
    return relayResult;
  }

  cancelTurn(threadId: ThreadId, turnId: TurnId, reason?: unknown): number {
    let cancelled = 0;
    const error = interactionCancelled(reason, "The Runtime turn reached a terminal state");
    for (const pending of [...this.pending.values()]) {
      if (pending.threadId === threadId && pending.turnId === turnId) {
        if (this.finishCancelled(pending, error)) {
          cancelled += 1;
        }
      }
    }
    return cancelled;
  }

  close(reason?: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelAll(interactionCancelled(reason, "Companion interaction broker was closed"));
    this.workspace = undefined;
  }

  private registerApproval(
    input: ApprovalRequestParamsV11 | ApprovalRequestParamsV12,
    context: RuntimeServerRequestContext,
  ): Promise<ApprovalRequestResult> {
    let params: RuntimeApprovalParams;
    try {
      params =
        "interactionId" in input
          ? approvalRequestParamsV12Schema.parse(input)
          : approvalRequestParamsV11Schema.parse(input);
    } catch (error: unknown) {
      return Promise.reject(asError(error, "Invalid Runtime approval request"));
    }
    const interactionId = isApprovalParamsV12(params)
      ? params.interactionId
      : this.nextInteractionId();
    const expiresAt = isApprovalParamsV12(params)
      ? params.expiresAt
      : (params.expiresAt ?? new Date(this.now() + this.legacyApprovalTimeoutMs).toISOString());
    const threadId = params.threadId;
    const turnId = params.approval.turnId;
    const approvalId = params.approval.id;
    if (this.approvalInteractions.has(approvalId)) {
      return Promise.reject(localApprovalDenied(`Approval "${approvalId}" is already pending`));
    }
    const deferred = Promise.withResolvers<ApprovalRequestResult>();
    const pending = this.createPendingBase<PendingApprovalInteraction>(
      {
        method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
        params,
        approval: params.approval,
        approvalId,
        interactionId,
        threadId,
        turnId,
        expiresAt,
        releaseLease: this.leases.acquire({ kind: "approval", id: approvalId }),
      },
      context,
      (result) => deferred.resolve(approvalRequestResultSchema.parse(result)),
      deferred.reject,
    );
    const explanation = getApprovalExplanation(params.approval);
    const request: CompanionInteractionRequestFrameDraftV11 = {
      type: RELAY_MESSAGE_TYPES_V11.interactionRequest,
      interactionId,
      threadId,
      turnId,
      expiresAt,
      sensitivity: "normal",
      method: RELAY_INTERACTION_METHODS_V11.approvalRequest,
      projection: {
        approvalId,
        agentName: params.approval.agentName,
        toolName: params.approval.toolName,
        ...(explanation === undefined ? {} : { explanation }),
      },
    };
    this.approvalInteractions.set(approvalId, interactionId);
    this.activatePending(pending, request);
    return deferred.promise;
  }

  private registerUserInput(
    input: UserInputRequestParamsV12,
    context: RuntimeServerRequestContext,
  ): Promise<UserInputResult> {
    let params: UserInputRequestParamsV12;
    try {
      params = userInputRequestParamsV12Schema.parse(input);
    } catch (error: unknown) {
      return Promise.reject(asError(error, "Invalid Runtime user input request"));
    }
    const deferred = Promise.withResolvers<UserInputResult>();
    const pending = this.createPendingBase<PendingUserInputInteraction>(
      {
        method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
        params,
        interactionId: params.interactionId,
        threadId: params.threadId,
        turnId: params.turnId,
        expiresAt: params.expiresAt,
        releaseLease: this.leases.acquire({ kind: "turn", id: params.turnId }),
      },
      context,
      (result) => deferred.resolve(userInputResultSchema.parse(result)),
      deferred.reject,
    );
    const projection = userInputFormSchema.parse({
      ...(params.title === undefined ? {} : { title: params.title }),
      ...(params.description === undefined ? {} : { description: params.description }),
      controls: params.controls,
    });
    const request: CompanionInteractionRequestFrameDraftV11 = {
      type: RELAY_MESSAGE_TYPES_V11.interactionRequest,
      interactionId: params.interactionId,
      threadId: params.threadId,
      turnId: params.turnId,
      expiresAt: params.expiresAt,
      sensitivity: params.sensitivity,
      method: RELAY_INTERACTION_METHODS_V11.userInputRequest,
      projection,
    };
    this.activatePending(pending, request);
    return deferred.promise;
  }

  private createPendingBase<TPending extends PendingInteraction>(
    input: Omit<
      TPending,
      | "runtimeSignal"
      | "resolve"
      | "reject"
      | "removeRuntimeAbortListener"
      | "deadlineTimer"
      | "requestPublished"
      | "activeCandidate"
    >,
    context: RuntimeServerRequestContext,
    resolve: (result: RuntimeInteractionResult) => void,
    reject: (error: Error) => void,
  ): TPending {
    const abort = () => {
      this.finishCancelled(
        pending,
        interactionCancelled(context.signal.reason, "Runtime cancelled the interaction"),
      );
    };
    const removeRuntimeAbortListener = () => {
      context.signal.removeEventListener("abort", abort);
    };
    const pending = {
      ...input,
      runtimeSignal: context.signal,
      resolve,
      reject,
      removeRuntimeAbortListener,
      deadlineTimer: undefined,
      requestPublished: false,
      activeCandidate: undefined,
    } as TPending;
    context.signal.addEventListener("abort", abort, { once: true });
    return pending;
  }

  private activatePending(
    pending: PendingInteraction,
    request: CompanionInteractionRequestFrameDraftV11,
  ): void {
    let workspace: BoundWorkspace;
    try {
      workspace = this.requireWorkspace();
    } catch (error: unknown) {
      pending.removeRuntimeAbortListener();
      pending.releaseLease();
      if (pending.method === RELAY_INTERACTION_METHODS_V11.approvalRequest) {
        this.approvalInteractions.delete(pending.approvalId);
      }
      pending.reject(asError(error, "Companion interaction broker is unavailable"));
      return;
    }
    if (this.pending.has(pending.interactionId)) {
      pending.removeRuntimeAbortListener();
      pending.releaseLease();
      if (pending.method === RELAY_INTERACTION_METHODS_V11.approvalRequest) {
        this.approvalInteractions.delete(pending.approvalId);
      }
      pending.reject(responderDenied(`Interaction "${pending.interactionId}" is already pending`));
      return;
    }
    if (Date.parse(pending.expiresAt) <= this.now()) {
      pending.removeRuntimeAbortListener();
      pending.releaseLease();
      if (pending.method === RELAY_INTERACTION_METHODS_V11.approvalRequest) {
        this.approvalInteractions.delete(pending.approvalId);
      }
      pending.reject(
        interactionCancelled(undefined, `Interaction expired at ${pending.expiresAt}`),
      );
      return;
    }
    this.pending.set(pending.interactionId, pending);
    if (pending.runtimeSignal.aborted) {
      this.finishCancelled(
        pending,
        interactionCancelled(pending.runtimeSignal.reason, "Runtime cancelled the interaction"),
      );
      return;
    }
    try {
      pending.requestPublished = true;
      workspace.publish(request);
    } catch (error: unknown) {
      pending.requestPublished = false;
      this.finishCancelled(
        pending,
        interactionCancelled(error, "Failed to publish the interaction request"),
      );
      return;
    }
    if (pending.runtimeSignal.aborted) {
      this.finishCancelled(
        pending,
        interactionCancelled(pending.runtimeSignal.reason, "Runtime cancelled the interaction"),
      );
      return;
    }
    this.scheduleDeadline(pending);
  }

  private scheduleDeadline(pending: PendingInteraction): void {
    const remaining = Date.parse(pending.expiresAt) - this.now();
    if (remaining <= 0) {
      this.finishCancelled(
        pending,
        interactionCancelled(undefined, `Interaction expired at ${pending.expiresAt}`),
      );
      return;
    }
    pending.deadlineTimer = setTimeout(
      () => this.scheduleDeadline(pending),
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
  }

  private async authorizeResponder(
    pending: PendingInteraction,
    context: RemoteInteractionCandidateContext,
    requestId: RelayRequestId,
    attemptSignal?: AbortSignal,
  ): Promise<void> {
    if (typeof context.responderPolicy !== "function") {
      throw responderDenied("Remote interaction candidate has no responder policy");
    }
    const signal = AbortSignal.any([
      pending.runtimeSignal,
      context.signal,
      ...(attemptSignal === undefined ? [] : [attemptSignal]),
    ]);
    let allowed: boolean;
    try {
      allowed = await raceWithAbort(
        () =>
          context.responderPolicy({
            workspaceId: context.workspaceId,
            requestId,
            interactionId: pending.interactionId,
            threadId: pending.threadId,
            turnId: pending.turnId,
            method: pending.method,
            responderContext: context.responderContext,
            signal,
          }),
        signal,
        "Remote responder policy was aborted",
      );
    } catch (error: unknown) {
      if (context.signal.aborted) {
        throw candidateAborted(context.signal.reason);
      }
      if (attemptSignal?.aborted === true) {
        throw candidateAborted(attemptSignal.reason);
      }
      if (!this.isStillPending(pending)) {
        throw interactionCancelled(error, "Interaction is no longer pending");
      }
      throw responderDenied("Remote responder policy failed closed");
    }
    if (context.signal.aborted) {
      throw candidateAborted(context.signal.reason);
    }
    this.assertStillPending(pending);
    if (allowed !== true) {
      throw responderDenied("Remote responder policy denied the interaction candidate");
    }
  }

  private async approveCandidate(
    pending: PendingApprovalInteraction,
    result: ApprovalRequestResult,
    generationSignal: AbortSignal,
  ): Promise<RelayInteractionCandidateResultV11> {
    const workspace = this.requireWorkspace();
    const activeController = pending.activeCandidate?.controller;
    const signal = AbortSignal.any([
      pending.runtimeSignal,
      generationSignal,
      ...(activeController === undefined ? [] : [activeController.signal]),
    ]);
    let localDecision: "allow" | "deny" | "require-local-confirmation";
    try {
      localDecision = parseLocalApprovalDecision(
        await raceWithAbort(
          () => workspace.localApprovalPolicy(pending.approval, { signal }),
          signal,
          "Local Companion policy was aborted",
        ),
      );
    } catch (error: unknown) {
      if (generationSignal.aborted) {
        throw candidateAborted(generationSignal.reason);
      }
      if (!this.isStillPending(pending)) {
        throw interactionCancelled(error, "Approval is no longer pending");
      }
      const denied = localApprovalDenied("Local Companion policy failed");
      this.finishCancelled(pending, denied);
      throw denied;
    }
    if (generationSignal.aborted) {
      throw candidateAborted(generationSignal.reason);
    }
    this.assertStillPending(pending);
    if (localDecision === "deny") {
      const denied = localApprovalDenied("Local Companion policy denied remote approval");
      this.finishResolved(
        pending,
        approvalRequestResultSchema.parse({
          decision: "reject",
          reason: "Local Companion policy denied remote approval",
        }),
      );
      throw denied;
    }
    if (localDecision === "require-local-confirmation") {
      throw localConfirmationRequired(
        "Local confirmation is required before this approval can continue",
      );
    }
    this.finishResolved(pending, approvalRequestResultSchema.parse(result));
    return { accepted: true };
  }

  private finishResolved(pending: PendingInteraction, result: RuntimeInteractionResult): boolean {
    return this.finish(pending, {
      type: RELAY_MESSAGE_TYPES_V11.interactionResolved,
      result,
    });
  }

  private finishCancelled(pending: PendingInteraction, error: Error): boolean {
    return this.finish(pending, {
      type: RELAY_MESSAGE_TYPES_V11.interactionCancelled,
      error,
    });
  }

  private finish(
    pending: PendingInteraction,
    outcome:
      | {
          readonly type: typeof RELAY_MESSAGE_TYPES_V11.interactionResolved;
          readonly result: RuntimeInteractionResult;
        }
      | {
          readonly type: typeof RELAY_MESSAGE_TYPES_V11.interactionCancelled;
          readonly error: Error;
        },
  ): boolean {
    if (!this.isStillPending(pending)) {
      return false;
    }
    this.pending.delete(pending.interactionId);
    if (pending.method === RELAY_INTERACTION_METHODS_V11.approvalRequest) {
      this.approvalInteractions.delete(pending.approvalId);
    }
    if (pending.deadlineTimer !== undefined) {
      clearTimeout(pending.deadlineTimer);
      pending.deadlineTimer = undefined;
    }
    pending.removeRuntimeAbortListener();
    pending.releaseLease();
    pending.activeCandidate?.controller.abort(
      outcome.type === RELAY_MESSAGE_TYPES_V11.interactionCancelled
        ? outcome.error
        : interactionCancelled(undefined, "Interaction was resolved"),
    );
    if (pending.requestPublished) {
      const workspace = this.workspace;
      try {
        workspace?.publish({
          type: outcome.type,
          interactionId: pending.interactionId,
          threadId: pending.threadId,
          turnId: pending.turnId,
          method: pending.method,
        });
      } catch {
        // Runtime settlement must remain single-shot even if the Relay publisher is unavailable.
      }
    }
    if (outcome.type === RELAY_MESSAGE_TYPES_V11.interactionResolved) {
      pending.resolve(outcome.result);
    } else {
      pending.reject(outcome.error);
    }
    return true;
  }

  private cancelAll(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      this.finishCancelled(pending, error);
    }
  }

  private clearCandidateAttempt(pending: PendingInteraction, attempt: CandidateAttempt): void {
    if (pending.activeCandidate === attempt) {
      pending.activeCandidate = undefined;
    }
  }

  private requireWorkspace(): BoundWorkspace {
    if (this.closed) {
      throw interactionCancelled(undefined, "Companion interaction broker is closed");
    }
    const workspace = this.workspace;
    if (workspace === undefined) {
      throw localApprovalDenied("Companion interaction broker is not bound to a workspace");
    }
    return workspace;
  }

  private nextInteractionId(): InteractionId {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const interactionId = interactionIdSchema.parse(this.createInteractionId());
      if (!this.pending.has(interactionId)) {
        return interactionId;
      }
    }
    throw new Error("Unable to allocate a unique interaction id");
  }

  private assertCandidateIdentity(
    pending: PendingInteraction | undefined,
    identity: z.output<typeof remoteCandidateIdentitySchema>,
  ): asserts pending is PendingInteraction {
    if (pending === undefined) {
      throw responderDenied(`Interaction "${identity.interactionId}" is no longer pending`);
    }
    if (
      pending.threadId !== identity.threadId ||
      pending.turnId !== identity.turnId ||
      pending.method !== identity.method
    ) {
      throw responderDenied(
        `Interaction "${identity.interactionId}" does not match its thread, turn, and method`,
      );
    }
  }

  private assertStillPending(pending: PendingInteraction): void {
    if (!this.isStillPending(pending)) {
      throw responderDenied(`Interaction "${pending.interactionId}" is no longer pending`);
    }
  }

  private isStillPending(pending: PendingInteraction): boolean {
    return this.pending.get(pending.interactionId) === pending;
  }
}

export function createRuntimeServerRequestHandlers(
  broker: CompanionInteractionBroker,
): RuntimeServerRequestHandlers {
  return {
    [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: broker.handleApprovalRequest,
    [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest]: broker.handleUserInputRequest,
  };
}
