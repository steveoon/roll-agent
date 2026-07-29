import {
  RUNTIME_METHODS,
  parseRuntimeMethodParams,
  type PendingApproval,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodInput,
  type RuntimeMethodResult,
} from "@roll-agent/protocol";
import type { RollNodeClient } from "@roll-agent/client-node";
import {
  CompanionEventBuffer,
  type CompanionEventBufferOptions,
  type EventBufferReplay,
} from "./event-buffer.ts";
import { WorkspaceLeaseManager } from "./lease-manager.ts";
import type { RelayRuntimeRequest } from "./relay-protocol.ts";

export const LOCAL_APPROVAL_DECISIONS = ["allow", "deny", "require-local-confirmation"] as const;

export type LocalApprovalDecision = (typeof LOCAL_APPROVAL_DECISIONS)[number];

export type LocalApprovalPolicy = (
  approval: PendingApproval,
) => LocalApprovalDecision | Promise<LocalApprovalDecision>;

export interface CompanionRuntimeClient {
  request<TMethod extends RuntimeMethod>(
    method: TMethod,
    input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>>;
  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
  close(): void;
  shutdown?(): Promise<unknown>;
}

export interface CompanionWorkspaceOptions extends CompanionEventBufferOptions {
  readonly client: CompanionRuntimeClient;
  readonly localApprovalPolicy: LocalApprovalPolicy;
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

export class CompanionWorkspace {
  readonly leases = new WorkspaceLeaseManager();
  readonly events: CompanionEventBuffer;

  private readonly client: CompanionRuntimeClient;
  private readonly localApprovalPolicy: LocalApprovalPolicy;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly eventListeners = new Set<
    (event: { readonly relaySequence: number; readonly event: RuntimeEventEnvelope }) => void
  >();
  private readonly releaseClientSubscription: () => void;

  constructor(options: CompanionWorkspaceOptions) {
    this.client = options.client;
    this.localApprovalPolicy = options.localApprovalPolicy;
    this.events = new CompanionEventBuffer({
      ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });
    this.releaseClientSubscription = this.client.onEvent((event) => this.handleEvent(event));
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
    this.leases.acquire({ kind: "turn", id: params.turnId });
    try {
      return await this.client.request(RUNTIME_METHODS.turnStart, params);
    } catch (error: unknown) {
      this.leases.release({ kind: "turn", id: params.turnId });
      throw error;
    }
  }

  async respondApproval(
    input: RuntimeMethodInput<"approval.respond">,
  ): Promise<RuntimeMethodResult<"approval.respond">> {
    const params = parseRuntimeMethodParams(RUNTIME_METHODS.approvalRespond, input);
    const approval = this.approvals.get(params.approvalId);
    if (approval === undefined) {
      throw new LocalApprovalDeniedError(`Approval "${params.approvalId}" is no longer pending`);
    }
    if (params.decision === "approve") {
      const localDecision = await this.localApprovalPolicy(approval);
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
    this.approvals.delete(params.approvalId);
    this.leases.release({ kind: "approval", id: params.approvalId });
    return result;
  }

  async handleRemoteRequest(request: RelayRuntimeRequest): Promise<unknown> {
    switch (request.method) {
      case RUNTIME_METHODS.initialize:
        throw new LocalApprovalDeniedError(
          "initialize is owned by the local Companion and cannot be relayed",
        );
      case RUNTIME_METHODS.threadList:
        return this.client.request(
          RUNTIME_METHODS.threadList,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadList, request.params),
        );
      case RUNTIME_METHODS.threadCreate:
        return this.client.request(
          RUNTIME_METHODS.threadCreate,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadCreate, request.params),
        );
      case RUNTIME_METHODS.threadOpen:
        return this.client.request(
          RUNTIME_METHODS.threadOpen,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadOpen, request.params),
        );
      case RUNTIME_METHODS.threadSnapshot:
        return this.client.request(
          RUNTIME_METHODS.threadSnapshot,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadSnapshot, request.params),
        );
      case RUNTIME_METHODS.threadRename:
        return this.client.request(
          RUNTIME_METHODS.threadRename,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadRename, request.params),
        );
      case RUNTIME_METHODS.threadDelete:
        return this.client.request(
          RUNTIME_METHODS.threadDelete,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadDelete, request.params),
        );
      case RUNTIME_METHODS.threadDetach:
        return this.client.request(
          RUNTIME_METHODS.threadDetach,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadDetach, request.params),
        );
      case RUNTIME_METHODS.threadCapabilities:
        return this.client.request(
          RUNTIME_METHODS.threadCapabilities,
          parseRuntimeMethodParams(RUNTIME_METHODS.threadCapabilities, request.params),
        );
      case RUNTIME_METHODS.turnStart:
        return this.startTurn(parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, request.params));
      case RUNTIME_METHODS.turnCancel:
        return this.client.request(
          RUNTIME_METHODS.turnCancel,
          parseRuntimeMethodParams(RUNTIME_METHODS.turnCancel, request.params),
        );
      case RUNTIME_METHODS.approvalRespond:
        return this.respondApproval(
          parseRuntimeMethodParams(RUNTIME_METHODS.approvalRespond, request.params),
        );
      case RUNTIME_METHODS.operationGet:
        return this.client.request(
          RUNTIME_METHODS.operationGet,
          parseRuntimeMethodParams(RUNTIME_METHODS.operationGet, request.params),
        );
    }
  }

  async closeIfIdle(): Promise<boolean> {
    if (!this.leases.canStopRuntime()) {
      return false;
    }
    this.releaseClientSubscription();
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
      listener(buffered);
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
      for (const [approvalId, approval] of this.approvals) {
        if (approval.turnId === event.turnId) {
          this.approvals.delete(approvalId);
          this.leases.release({ kind: "approval", id: approvalId });
        }
      }
      return;
    }
    if (event.event.type === "approval.required") {
      const approval = event.event.approval;
      this.approvals.set(approval.id, approval);
      this.leases.acquire({ kind: "approval", id: approval.id });
    }
  }
}

export function isRollNodeClient(client: CompanionRuntimeClient): client is RollNodeClient {
  return "getOutcomeUnknownTurnIds" in client;
}
