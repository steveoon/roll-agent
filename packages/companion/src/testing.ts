import {
  RELAY_REQUEST_METHODS_V11,
  relayAckSchemaV11,
  relayMessageSchemaV11,
  relayRuntimeRequestSchemaV11,
  type RelayInteractionCandidateParamsV11,
  type RelayMessageV11,
  type RelayRequestId,
  type RelayRuntimeRequestV11,
  type WorkspaceId,
} from "@roll-agent/relay-protocol";
import type { RelayTransportV11 } from "./relay-bridge-v11.ts";

export interface InMemoryRelayCandidateInputV11 {
  readonly requestId: RelayRequestId;
  readonly workspaceId: WorkspaceId;
  readonly params: RelayInteractionCandidateParamsV11;
}

type MessageListener = (message: unknown) => void;
type CloseListener = () => void;

function createCandidateRequestV11(input: InMemoryRelayCandidateInputV11): RelayRuntimeRequestV11 {
  return relayRuntimeRequestSchemaV11.parse({
    type: "runtime.request",
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    method: RELAY_REQUEST_METHODS_V11.interactionCandidate,
    params: input.params,
  });
}

/**
 * Deterministic in-memory Wire 1.1 transport for Companion tests.
 *
 * This fake provides no authentication, device or controller election, reliable delivery,
 * persistent outbox, or interaction WAL. It must never be used as a production identity or
 * transport implementation.
 */
export class InMemoryRelayTransportV11 implements RelayTransportV11 {
  private readonly outboundMessages: RelayMessageV11[] = [];
  private readonly messageListeners = new Set<MessageListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private lateMessageListeners: readonly MessageListener[] = [];
  private disconnected = false;

  get outbound(): readonly RelayMessageV11[] {
    return this.outboundMessages;
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }

  send(message: RelayMessageV11): void {
    if (this.disconnected) {
      throw new Error("Cannot send on a disconnected in-memory Relay transport");
    }
    this.outboundMessages.push(relayMessageSchemaV11.parse(message));
  }

  onMessage(listener: MessageListener): () => void {
    if (this.disconnected) {
      throw new Error("Cannot subscribe to a disconnected in-memory Relay transport");
    }
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onClose(listener: CloseListener): () => void {
    if (this.disconnected) {
      throw new Error("Cannot subscribe to a disconnected in-memory Relay transport");
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    this.disconnect();
  }

  injectCandidate(input: InMemoryRelayCandidateInputV11): RelayRuntimeRequestV11 {
    const request = createCandidateRequestV11(input);
    this.emit(request, this.messageListeners);
    return request;
  }

  injectDuplicateCandidate(input: InMemoryRelayCandidateInputV11): RelayRuntimeRequestV11 {
    const request = createCandidateRequestV11(input);
    this.emit(request, this.messageListeners);
    this.emit(request, this.messageListeners);
    return request;
  }

  injectAck(workspaceId: WorkspaceId, throughRelaySequence: number): void {
    this.emitMessage(
      relayAckSchemaV11.parse({
        type: "runtime.ack",
        workspaceId,
        throughRelaySequence,
      }),
      this.messageListeners,
    );
  }

  /** Delivers a candidate to the generation listeners captured immediately before disconnect. */
  injectLateCandidate(input: InMemoryRelayCandidateInputV11): RelayRuntimeRequestV11 {
    if (!this.disconnected) {
      throw new Error("Late candidate injection requires a disconnected transport generation");
    }
    const request = createCandidateRequestV11(input);
    this.emit(request, this.lateMessageListeners);
    return request;
  }

  disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.lateMessageListeners = [...this.messageListeners];
    for (const listener of [...this.closeListeners]) {
      listener();
    }
  }

  private emit(message: RelayRuntimeRequestV11, listeners: Iterable<MessageListener>): void {
    if (this.disconnected && listeners === this.messageListeners) {
      throw new Error("Cannot inject into a disconnected in-memory Relay transport");
    }
    for (const listener of [...listeners]) {
      listener(message);
    }
  }

  private emitMessage(message: unknown, listeners: Iterable<MessageListener>): void {
    if (this.disconnected && listeners === this.messageListeners) {
      throw new Error("Cannot inject into a disconnected in-memory Relay transport");
    }
    for (const listener of [...listeners]) {
      listener(message);
    }
  }
}
