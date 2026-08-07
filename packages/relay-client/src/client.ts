import {
  RELAY_ERROR_CODES_V11,
  RELAY_MESSAGE_TYPES_V11,
  RELAY_REQUEST_METHODS_V11,
  RELAY_REQUEST_METHOD_DISPOSITIONS_V11,
  parseRelayInteractionCandidateForRequestV11,
  parseRelayRequestParamsForVersion,
  parseRelayRequestResultForVersion,
  relayAckSchemaV11,
  relayMessageSchemaV11,
  relayRequestIdSchema,
  relayRequestMethodSchemasV11,
  relayRuntimeRequestSchemaV11,
  type RelayInteractionCancelledV11,
  type RelayInteractionRequestV11,
  type RelayInteractionResolvedV11,
  type RelayMessageV11,
  type RelayRequestMethodForVersion,
  type RelayRequestParamsForVersion,
  type RelayRequestResultForVersion,
  type RelayRuntimeEventV11,
  type WorkspaceId,
} from "@roll-agent/relay-protocol";
import {
  parseRelayBrowserFirstControlFrame,
  relayBrowserControlMessageSchema,
  relaySessionDescriptorSchema,
} from "@roll-agent/relay-protocol/control";
import { z } from "zod/v4";

import {
  RELAY_CLIENT_TRANSPORT_ERROR_CODES,
  getPendingInteractionRequest,
  relayClientErrorDetailsSchema,
  relayConnectionStateSchema,
  relayThreadViewSchema,
  type RelayClientErrorDetails,
  type RelayConnectionState,
  type RelayInteractionState,
  type RelayLiveAssistantMessage,
  type RelayThreadView,
  type RelayTurnState,
} from "./schemas.ts";
import {
  browserRelayRuntimeDependencies,
  type RelayClientRuntimeDependencies,
  type RelayTimerHandle,
  type RelayWebSocketLike,
} from "./transport.ts";

type RelayMethodV11 = RelayRequestMethodForVersion<"1.1">;
type ThreadListWireInput = z.input<(typeof relayRequestMethodSchemasV11)["thread.list"]["params"]>;
type ThreadCreateWireInput = z.input<
  (typeof relayRequestMethodSchemasV11)["thread.create"]["params"]
>;
type ThreadListWireResult = RelayRequestResultForVersion<"1.1", "thread.list">;
type ThreadCreateWireResult = RelayRequestResultForVersion<"1.1", "thread.create">;
type ThreadOpenWireResult = RelayRequestResultForVersion<"1.1", "thread.open">;
type ThreadSnapshotWireResult = RelayRequestResultForVersion<"1.1", "thread.snapshot">;
type TurnStartWireResult = RelayRequestResultForVersion<"1.1", "turn.start">;
type TurnCancelWireResult = RelayRequestResultForVersion<"1.1", "turn.cancel">;
type InteractionCandidateWireResult = RelayRequestResultForVersion<"1.1", "interaction.candidate">;

export type RelayThreadId = ThreadOpenWireResult["thread"]["id"];
export type RelayTurnId = RelayRequestParamsForVersion<"1.1", "turn.cancel">["turnId"];
export type RelayInteractionId = RelayInteractionRequestV11["interactionId"];
export type RelayThreadSummary = ThreadListWireResult["items"][number];
export type RelayThreadListInput = Omit<ThreadListWireInput, "limit"> & {
  readonly limit?: ThreadListWireInput["limit"];
};
export type RelayThreadCreateInput = Omit<ThreadCreateWireInput, "requestId">;
export type RelayThreadListResult = ThreadListWireResult;
export type RelayThreadSnapshot = ThreadSnapshotWireResult;
export type RelayTurnStartResult = TurnStartWireResult;
export type RelayTurnCancelResult = TurnCancelWireResult;
export type RelayInteractionCandidateResult = InteractionCandidateWireResult;

export interface RelaySessionProviderInput {
  readonly signal: AbortSignal;
}

export type RelaySessionProvider = (input: RelaySessionProviderInput) => Promise<unknown>;

export interface RelayRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CreateRelayClientOptions {
  readonly getSession: RelaySessionProvider;
  readonly requestTimeoutMs?: number;
}

export type RelayConnectionListener = (state: RelayConnectionState) => void;
export type RelayThreadListener = (view: RelayThreadView) => void;
export type RelayUnsubscribe = () => void;

export interface RelayThread {
  readonly id: RelayThreadId;
  getSnapshot(): RelayThreadView;
  subscribe(listener: RelayThreadListener): RelayUnsubscribe;
  send(text: string, options?: RelayRequestOptions): Promise<RelayTurnStartResult>;
  cancel(turnId: RelayTurnId, options?: RelayRequestOptions): Promise<RelayTurnCancelResult>;
  respond(
    interactionId: RelayInteractionId,
    candidate: unknown,
    options?: RelayRequestOptions,
  ): Promise<RelayInteractionCandidateResult>;
  refresh(options?: RelayRequestOptions): Promise<RelayThreadSnapshot>;
}

export interface RelayClient {
  connect(options?: RelayRequestOptions): Promise<void>;
  close(): void;
  getConnectionState(): RelayConnectionState;
  subscribeConnection(listener: RelayConnectionListener): RelayUnsubscribe;
  listThreads(
    input?: RelayThreadListInput,
    options?: RelayRequestOptions,
  ): Promise<RelayThreadListResult>;
  createThread(input?: RelayThreadCreateInput, options?: RelayRequestOptions): Promise<RelayThread>;
  openThread(threadId: RelayThreadId, options?: RelayRequestOptions): Promise<RelayThread>;
}

export class RelayClientError extends Error {
  readonly details: RelayClientErrorDetails;

  constructor(details: RelayClientErrorDetails) {
    super(details.message);
    this.name = "RelayClientError";
    this.details = relayClientErrorDetailsSchema.parse(details);
  }
}

interface PendingRequest {
  readonly requestId: string;
  readonly method: RelayMethodV11;
  readonly frame: string;
  readonly mutation: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RelayClientError) => void;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
  timeoutHandle: RelayTimerHandle | undefined;
  sent: boolean;
}

interface ConnectAttempt {
  ready: boolean;
  settled: boolean;
}

interface SequencedRelayMessage {
  readonly relaySequence: number;
  readonly message:
    | RelayRuntimeEventV11
    | RelayInteractionRequestV11
    | RelayInteractionResolvedV11
    | RelayInteractionCancelledV11;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN_STATE = 1;
const EMPTY_RELAY_SEQUENCE_CURSOR = -1;

const BROWSER_LEGAL_RELAY_CLOSE_CODES = {
  normal: 1000,
  invalidFrame: 4002,
  sessionFatal: 4008,
  sessionRetryable: 4012,
} as const;

const TERMINAL_TURN_STATUSES: ReadonlySet<RelayTurnState["status"]> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

type RelayOptimisticTurnState = Extract<
  RelayTurnState,
  { readonly status: "running" | "cancelling" }
>;

function transportError(
  code: (typeof RELAY_CLIENT_TRANSPORT_ERROR_CODES)[keyof typeof RELAY_CLIENT_TRANSPORT_ERROR_CODES],
  message: string,
  retryable: boolean,
): RelayClientError {
  return new RelayClientError({ kind: "transport", code, message, retryable });
}

function asRelayClientError(error: unknown): RelayClientError {
  if (error instanceof RelayClientError) {
    return error;
  }
  return transportError(
    RELAY_CLIENT_TRANSPORT_ERROR_CODES.transportError,
    error instanceof Error ? error.message : "Relay transport failed",
    true,
  );
}

function notifyListener<TValue>(listener: (value: TValue) => void, value: TValue): void {
  try {
    listener(value);
  } catch (error) {
    if (typeof globalThis.reportError === "function") {
      try {
        globalThis.reportError(error);
      } catch {
        // Listener diagnostics must never re-enter the Relay protocol state machine.
      }
    }
  }
}

function parseTextFrame(data: unknown): unknown {
  if (typeof data !== "string") {
    throw transportError(
      RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
      "Relay sent a non-text frame",
      false,
    );
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw transportError(
      RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
      "Relay sent invalid JSON",
      false,
    );
  }
}

function parseSessionReadyFrame(
  value: unknown,
): ReturnType<typeof parseRelayBrowserFirstControlFrame> {
  try {
    return parseRelayBrowserFirstControlFrame(value);
  } catch {
    throw transportError(
      RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
      "Relay first frame must be Control 1.0 session.ready for Wire 1.1",
      false,
    );
  }
}

function getTurnStateFromSnapshot(snapshot: RelayThreadSnapshot): RelayTurnState {
  const activeTurn = snapshot.activeTurn;
  if (activeTurn === undefined) {
    return { status: "idle" };
  }
  return activeTurn.status === "cancelling"
    ? { status: "cancelling", turnId: activeTurn.id }
    : { status: "running", turnId: activeTurn.id };
}

function replaceLiveMessage(
  messages: readonly RelayLiveAssistantMessage[],
  next: RelayLiveAssistantMessage,
): readonly RelayLiveAssistantMessage[] {
  const index = messages.findIndex((message) => message.streamId === next.streamId);
  if (index === -1) {
    return [...messages, next];
  }
  return messages.map((message, messageIndex) => (messageIndex === index ? next : message));
}

function createInteractionTerminalState(
  status: "resolved" | "cancelled",
  message: RelayInteractionResolvedV11 | RelayInteractionCancelledV11,
): RelayInteractionState {
  return {
    status,
    interactionId: message.interactionId,
    threadId: message.threadId,
    turnId: message.turnId,
    method: message.method,
  };
}

class RelayThreadImpl implements RelayThread {
  readonly id: RelayThreadId;
  readonly #client: RelayClientImpl;
  readonly #listeners = new Set<RelayThreadListener>();
  #view: RelayThreadView;

  constructor(client: RelayClientImpl, id: RelayThreadId) {
    this.#client = client;
    this.id = id;
    this.#view = relayThreadViewSchema.parse({
      status: "loading",
      threadId: id,
      snapshot: null,
      liveAssistantMessages: [],
      interactions: [],
      turn: { status: "idle" },
    });
  }

  getSnapshot(): RelayThreadView {
    return this.#view;
  }

  subscribe(listener: RelayThreadListener): RelayUnsubscribe {
    this.#listeners.add(listener);
    notifyListener(listener, this.#view);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async send(text: string, options?: RelayRequestOptions): Promise<RelayTurnStartResult> {
    const result = await this.#client.startTurn(this.id, text, options);
    this.#publishOptimisticTurn({ status: "running", turnId: result.turnId });
    return result;
  }

  async cancel(turnId: RelayTurnId, options?: RelayRequestOptions): Promise<RelayTurnCancelResult> {
    const result = await this.#client.cancelTurn(this.id, turnId, options);
    if (result.cancelling) {
      this.#publishOptimisticTurn({ status: "cancelling", turnId });
    }
    return result;
  }

  async respond(
    interactionId: RelayInteractionId,
    candidate: unknown,
    options?: RelayRequestOptions,
  ): Promise<RelayInteractionCandidateResult> {
    const interaction = this.#view.interactions.find((item) => {
      const request = getPendingInteractionRequest(item);
      return request?.interactionId === interactionId;
    });
    const request =
      interaction === undefined ? undefined : getPendingInteractionRequest(interaction);
    if (request === undefined) {
      throw transportError(
        RELAY_CLIENT_TRANSPORT_ERROR_CODES.connectionUnavailable,
        "Interaction is no longer pending in this Browser session",
        false,
      );
    }

    this.#setInteractionStatus(interactionId, "responding");
    try {
      return await this.#client.respondToInteraction(request, candidate, options);
    } catch (error) {
      this.#setInteractionStatus(interactionId, "pending");
      throw error;
    }
  }

  async refresh(options?: RelayRequestOptions): Promise<RelayThreadSnapshot> {
    try {
      const snapshot = await this.#client.getThreadSnapshot(this.id, options);
      this.applySnapshot(snapshot);
      return snapshot;
    } catch (error) {
      this.applyError(asRelayClientError(error).details);
      throw error;
    }
  }

  applySnapshot(snapshot: RelayThreadSnapshot): void {
    this.#publish({
      status: "ready",
      threadId: this.id,
      snapshot,
      liveAssistantMessages: [],
      interactions: this.#view.interactions,
      turn: getTurnStateFromSnapshot(snapshot),
    });
  }

  applyError(error: RelayClientErrorDetails): void {
    this.#publish({
      status: "error",
      threadId: this.id,
      snapshot: this.#view.snapshot,
      liveAssistantMessages: this.#view.liveAssistantMessages,
      interactions: this.#view.interactions,
      turn: this.#view.turn,
      error,
    });
  }

  applyRuntimeEvent(message: RelayRuntimeEventV11): void {
    const envelope = message.event;
    const event = envelope.event;
    const turnId = envelope.turnId;
    let messages = this.#view.liveAssistantMessages;
    let turn = this.#view.turn;

    if (event.type === "message.started") {
      messages = replaceLiveMessage(messages, {
        status: "streaming",
        streamId: event.streamId,
        text: "",
      });
    } else if (event.type === "message.delta") {
      const current = messages.find((item) => item.streamId === event.streamId);
      messages = replaceLiveMessage(messages, {
        status: "streaming",
        streamId: event.streamId,
        text: `${current?.text ?? ""}${event.delta}`,
      });
    } else if (event.type === "message.completed") {
      messages = replaceLiveMessage(messages, {
        status: "completed",
        streamId: event.streamId,
        text: event.text,
      });
    } else if (event.type === "turn.started" && turnId !== undefined) {
      turn = { status: "running", turnId };
    } else if (event.type === "turn.completed" && turnId !== undefined) {
      turn = { status: "completed", turnId };
    } else if (event.type === "turn.cancelled" && turnId !== undefined) {
      turn = { status: "cancelled", turnId };
    } else if (event.type === "turn.failed" && turnId !== undefined) {
      turn = { status: "failed", turnId, stage: event.stage };
    }

    this.#publishReadyFields({ liveAssistantMessages: messages, turn });
    if (
      event.type === "turn.completed" ||
      event.type === "turn.cancelled" ||
      event.type === "turn.failed"
    ) {
      this.refresh().catch(() => undefined);
    }
  }

  applyInteractionRequest(request: RelayInteractionRequestV11): void {
    const existing = this.#view.interactions.findIndex((interaction) => {
      const pending = getPendingInteractionRequest(interaction);
      return pending?.interactionId === request.interactionId;
    });
    const next: RelayInteractionState = { status: "pending", request };
    const interactions =
      existing === -1
        ? [...this.#view.interactions, next]
        : this.#view.interactions.map((interaction, index) =>
            index === existing ? next : interaction,
          );
    this.#publishReadyFields({ interactions });
  }

  applyInteractionTerminal(
    message: RelayInteractionResolvedV11 | RelayInteractionCancelledV11,
  ): void {
    const terminal = createInteractionTerminalState(
      message.type === RELAY_MESSAGE_TYPES_V11.interactionResolved ? "resolved" : "cancelled",
      message,
    );
    const index = this.#view.interactions.findIndex((interaction) => {
      const request = getPendingInteractionRequest(interaction);
      return request?.interactionId === message.interactionId;
    });
    const interactions =
      index === -1
        ? [...this.#view.interactions, terminal]
        : this.#view.interactions.map((interaction, itemIndex) =>
            itemIndex === index ? terminal : interaction,
          );
    this.#publishReadyFields({ interactions });
  }

  #publishOptimisticTurn(turn: RelayOptimisticTurnState): void {
    const current = this.#view.turn;
    if (
      current.status !== "idle" &&
      current.turnId === turn.turnId &&
      TERMINAL_TURN_STATUSES.has(current.status)
    ) {
      return;
    }
    this.#publishReadyFields({ turn });
  }

  #setInteractionStatus(interactionId: RelayInteractionId, status: "pending" | "responding") {
    const interactions = this.#view.interactions.map((interaction) => {
      const request = getPendingInteractionRequest(interaction);
      return request?.interactionId === interactionId ? { status, request } : interaction;
    });
    this.#publishReadyFields({ interactions });
  }

  #publishReadyFields(fields: {
    readonly liveAssistantMessages?: readonly RelayLiveAssistantMessage[];
    readonly interactions?: readonly RelayInteractionState[];
    readonly turn?: RelayTurnState;
  }): void {
    const shared = {
      threadId: this.id,
      snapshot: this.#view.snapshot,
      liveAssistantMessages: fields.liveAssistantMessages ?? this.#view.liveAssistantMessages,
      interactions: fields.interactions ?? this.#view.interactions,
      turn: fields.turn ?? this.#view.turn,
    } as const;
    this.#publish(
      this.#view.snapshot === null
        ? { status: "loading", ...shared, snapshot: null }
        : { status: "ready", ...shared, snapshot: this.#view.snapshot },
    );
  }

  #publish(view: z.input<typeof relayThreadViewSchema>): void {
    this.#view = relayThreadViewSchema.parse(view);
    for (const listener of this.#listeners) {
      notifyListener(listener, this.#view);
    }
  }
}

export class RelayClientImpl implements RelayClient {
  readonly #options: CreateRelayClientOptions;
  readonly #runtime: RelayClientRuntimeDependencies;
  readonly #connectionListeners = new Set<RelayConnectionListener>();
  readonly #threads = new Map<RelayThreadId, RelayThreadImpl>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #sequencedBuffer = new Map<number, SequencedRelayMessage>();
  #connectionState: RelayConnectionState = { status: "idle" };
  #socket: RelayWebSocketLike | undefined;
  #workspaceId: WorkspaceId | undefined;
  #connectPromise: Promise<void> | undefined;
  #sessionAbortController: AbortController | undefined;
  #reconnectTimer: RelayTimerHandle | undefined;
  #reconnectAttempt = 0;
  #closedByClient = false;
  #permanentlyClosed = false;
  #lastRelaySequence = EMPTY_RELAY_SEQUENCE_CURSOR;
  #recovering = false;
  #streamEpoch = 0;
  #resynchronizing = false;
  readonly #requestTimeoutMs: number;

  constructor(options: CreateRelayClientOptions, runtime: RelayClientRuntimeDependencies) {
    this.#options = options;
    this.#runtime = runtime;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new TypeError("requestTimeoutMs must be a positive finite number");
    }
  }

  async connect(options?: RelayRequestOptions): Promise<void> {
    if (this.#connectionState.status === "connected") {
      return;
    }
    if (this.#closedByClient) {
      throw transportError(
        RELAY_CLIENT_TRANSPORT_ERROR_CODES.closed,
        "Relay client is closed",
        false,
      );
    }
    this.#clearReconnectTimer();
    const inFlight = this.#connectPromise;
    if (inFlight !== undefined) {
      return inFlight;
    }
    this.#permanentlyClosed = false;
    this.#reconnectAttempt = 0;
    this.#setConnectionState({ status: "connecting", attempt: 1 });
    return this.#beginSessionAttempt(options?.signal, options?.timeoutMs).catch(
      (error: unknown) => {
        const clientError = asRelayClientError(error);
        if (!this.#closedByClient && !this.#permanentlyClosed) {
          this.#setConnectionState({
            status: "closed",
            reason: clientError.details.kind === "session" ? "session" : "transport",
          });
        }
        throw clientError;
      },
    );
  }

  close(): void {
    if (this.#closedByClient) {
      return;
    }
    this.#closedByClient = true;
    this.#permanentlyClosed = true;
    this.#sessionAbortController?.abort();
    this.#clearReconnectTimer();
    this.#discardSocket("client closed");
    this.#rejectAllPending(true);
    this.#setConnectionState({ status: "closed", reason: "client" });
  }

  getConnectionState(): RelayConnectionState {
    return this.#connectionState;
  }

  subscribeConnection(listener: RelayConnectionListener): RelayUnsubscribe {
    this.#connectionListeners.add(listener);
    notifyListener(listener, this.#connectionState);
    return () => {
      this.#connectionListeners.delete(listener);
    };
  }

  async listThreads(
    input: RelayThreadListInput = {},
    options?: RelayRequestOptions,
  ): Promise<RelayThreadListResult> {
    return this.#request(RELAY_REQUEST_METHODS_V11.threadList, input, options);
  }

  async createThread(
    input: RelayThreadCreateInput = {},
    options?: RelayRequestOptions,
  ): Promise<RelayThread> {
    const result: ThreadCreateWireResult = await this.#request(
      RELAY_REQUEST_METHODS_V11.threadCreate,
      { ...input, requestId: this.#runtime.createUuid() },
      options,
    );
    const thread = this.#getOrCreateThread(result.thread.id);
    await thread.refresh(options).catch(() => undefined);
    return thread;
  }

  async openThread(threadId: RelayThreadId, options?: RelayRequestOptions): Promise<RelayThread> {
    const snapshot = await this.#request(
      RELAY_REQUEST_METHODS_V11.threadOpen,
      { threadId },
      options,
    );
    const thread = this.#getOrCreateThread(threadId);
    thread.applySnapshot(snapshot);
    return thread;
  }

  async startTurn(
    threadId: RelayThreadId,
    text: string,
    options?: RelayRequestOptions,
  ): Promise<RelayTurnStartResult> {
    return this.#request(
      RELAY_REQUEST_METHODS_V11.turnStart,
      {
        requestId: this.#runtime.createUuid(),
        threadId,
        turnId: this.#runtime.createUuid(),
        input: { text },
      },
      options,
    );
  }

  async cancelTurn(
    threadId: RelayThreadId,
    turnId: RelayTurnId,
    options?: RelayRequestOptions,
  ): Promise<RelayTurnCancelResult> {
    return this.#request(
      RELAY_REQUEST_METHODS_V11.turnCancel,
      { requestId: this.#runtime.createUuid(), threadId, turnId },
      options,
    );
  }

  async respondToInteraction(
    request: RelayInteractionRequestV11,
    candidate: unknown,
    options?: RelayRequestOptions,
  ): Promise<RelayInteractionCandidateResult> {
    const params = parseRelayInteractionCandidateForRequestV11(request, candidate);
    return this.#request(RELAY_REQUEST_METHODS_V11.interactionCandidate, params, options);
  }

  async getThreadSnapshot(
    threadId: RelayThreadId,
    options?: RelayRequestOptions,
  ): Promise<RelayThreadSnapshot> {
    return this.#request(
      RELAY_REQUEST_METHODS_V11.threadSnapshot,
      { threadId, limit: 100 },
      options,
    );
  }

  async #openSession(externalSignal?: AbortSignal, requestedTimeoutMs?: number): Promise<void> {
    const timeoutMs = requestedTimeoutMs ?? this.#requestTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    const sessionAbortController = new AbortController();
    this.#sessionAbortController = sessionAbortController;
    let timedOut = false;
    const abortFromExternal = () => {
      sessionAbortController.abort();
    };
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    if (externalSignal?.aborted === true) {
      sessionAbortController.abort();
    }

    const timeoutHandle = this.#runtime.scheduler.setTimer(() => {
      timedOut = true;
      sessionAbortController.abort();
    }, timeoutMs);
    const cancellation = new Promise<never>((_resolve, reject) => {
      const rejectCancellation = () => {
        reject(
          transportError(
            timedOut
              ? RELAY_CLIENT_TRANSPORT_ERROR_CODES.requestTimeout
              : RELAY_CLIENT_TRANSPORT_ERROR_CODES.aborted,
            timedOut ? "Relay session connection timed out" : "Relay session request was aborted",
            timedOut,
          ),
        );
        this.#socket?.close(BROWSER_LEGAL_RELAY_CLOSE_CODES.normal, "session attempt cancelled");
      };
      if (sessionAbortController.signal.aborted) {
        rejectCancellation();
      } else {
        sessionAbortController.signal.addEventListener("abort", rejectCancellation, { once: true });
      }
    });

    try {
      await Promise.race([this.#establishSession(sessionAbortController.signal), cancellation]);
    } finally {
      this.#runtime.scheduler.clearTimer(timeoutHandle);
      externalSignal?.removeEventListener("abort", abortFromExternal);
      if (this.#sessionAbortController === sessionAbortController) {
        this.#sessionAbortController = undefined;
      }
    }
  }

  async #establishSession(signal: AbortSignal): Promise<void> {
    try {
      let rawSession: unknown;
      try {
        rawSession = await this.#options.getSession({ signal });
      } catch (error) {
        if (signal.aborted) {
          throw transportError(
            RELAY_CLIENT_TRANSPORT_ERROR_CODES.aborted,
            "Relay session request was aborted",
            false,
          );
        }
        throw asRelayClientError(error);
      }
      if (signal.aborted) {
        throw transportError(
          RELAY_CLIENT_TRANSPORT_ERROR_CODES.aborted,
          "Relay session request was aborted",
          false,
        );
      }

      const parsedSession = relaySessionDescriptorSchema.safeParse(rawSession);
      if (!parsedSession.success) {
        throw transportError(
          RELAY_CLIENT_TRANSPORT_ERROR_CODES.invalidSession,
          "Session endpoint returned an invalid Relay session",
          false,
        );
      }
      if (Date.parse(parsedSession.data.expiresAt) <= this.#runtime.scheduler.now()) {
        throw transportError(
          RELAY_CLIENT_TRANSPORT_ERROR_CODES.invalidSession,
          "Session endpoint returned an expired Relay session",
          false,
        );
      }

      this.#discardSocket("superseded relay session");
      const socket = this.#runtime.createWebSocket(parsedSession.data.connectUrl);
      this.#socket = socket;
      await this.#waitForSessionReady(socket);
    } catch (error) {
      throw asRelayClientError(error);
    }
  }

  #waitForSessionReady(socket: RelayWebSocketLike): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const attempt: ConnectAttempt = { ready: false, settled: false };
      const fail = (error: RelayClientError) => {
        if (attempt.settled) {
          return;
        }
        attempt.settled = true;
        reject(error);
      };
      socket.setHandlers({
        onOpen: () => undefined,
        onMessage: (data) => {
          if (attempt.ready && this.#socket !== socket) {
            return;
          }
          try {
            const value = parseTextFrame(data);
            if (!attempt.ready) {
              const ready = parseSessionReadyFrame(value);
              if (this.#workspaceId !== undefined && this.#workspaceId !== ready.workspaceId) {
                throw transportError(
                  RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
                  "Relay session changed the bound Workspace",
                  false,
                );
              }
              this.#workspaceId = ready.workspaceId;
              attempt.ready = true;
              attempt.settled = true;
              this.#reconnectAttempt = 0;
              this.#resynchronizing = true;
              this.#setConnectionState({
                status: "connected",
                workspaceStatus: ready.workspaceStatus,
              });
              this.#sendAck();
              if (ready.workspaceStatus === "online") {
                this.#replayPendingMutations();
              }
              resolve();
              return;
            }
            this.#handleInboundValue(value);
          } catch (error) {
            const clientError = asRelayClientError(error);
            if (!attempt.ready) {
              fail(clientError);
            } else {
              this.#failProtocol(clientError);
            }
            socket.close(BROWSER_LEGAL_RELAY_CLOSE_CODES.invalidFrame, "invalid relay frame");
          }
        },
        onClose: () => {
          const current = this.#socket === socket;
          if (current) {
            this.#socket = undefined;
          }
          if (!attempt.ready) {
            fail(
              transportError(
                RELAY_CLIENT_TRANSPORT_ERROR_CODES.transportError,
                "Relay connection closed before session.ready",
                true,
              ),
            );
            return;
          }
          if (!current) {
            return;
          }
          this.#handleUnexpectedClose();
        },
        onError: () => {
          if (!attempt.ready) {
            fail(
              transportError(
                RELAY_CLIENT_TRANSPORT_ERROR_CODES.transportError,
                "Relay WebSocket failed before session.ready",
                true,
              ),
            );
          }
        },
      });
    });
  }

  #handleInboundValue(value: unknown): void {
    const control = relayBrowserControlMessageSchema.safeParse(value);
    if (control.success) {
      this.#handleControlMessage(control.data);
      return;
    }

    const wire = relayMessageSchemaV11.safeParse(value);
    if (!wire.success) {
      throw transportError(
        RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
        "Relay sent an invalid Control 1.0 or Wire 1.1 frame",
        false,
      );
    }
    this.#handleWireMessage(wire.data);
  }

  #handleControlMessage(message: z.output<typeof relayBrowserControlMessageSchema>): void {
    if (message.type === "session.ready") {
      throw transportError(
        RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
        "session.ready may only be the first frame",
        false,
      );
    }
    if (message.type === "workspace.status") {
      this.#assertWorkspace(message.workspaceId);
      const previous = this.#connectionState;
      const recovered =
        previous.status === "connected" &&
        previous.workspaceStatus === "offline" &&
        message.status === "online";
      this.#setConnectionState({ status: "connected", workspaceStatus: message.status });
      if (recovered) {
        this.#resynchronizing = true;
        this.#refreshOpenThreads();
      }
      if (message.status === "online") {
        this.#replayPendingMutations();
      }
      return;
    }

    const error = new RelayClientError({
      kind: "session",
      code: message.code,
      message: `Relay session failed: ${message.code}`,
      retryable: message.retryable,
    });
    if (message.retryable) {
      this.#socket?.close(
        BROWSER_LEGAL_RELAY_CLOSE_CODES.sessionRetryable,
        "retryable relay session error",
      );
      return;
    }
    this.#permanentlyClosed = true;
    this.#rejectAllPending(true);
    for (const thread of this.#threads.values()) {
      thread.applyError(error.details);
    }
    this.#setConnectionState({ status: "closed", reason: "session" });
    this.#socket?.close(
      BROWSER_LEGAL_RELAY_CLOSE_CODES.sessionFatal,
      "non-retryable relay session error",
    );
  }

  #handleWireMessage(message: RelayMessageV11): void {
    if (message.type === RELAY_MESSAGE_TYPES_V11.runtimeResponse) {
      this.#handleRuntimeResponse(message);
      return;
    }
    if (message.type === RELAY_MESSAGE_TYPES_V11.runtimeGap) {
      this.#assertWorkspace(message.workspaceId);
      this.#reconcileResynchronizedStream(message.throughRelaySequence);
      this.#beginGapRecovery(message.throughRelaySequence);
      return;
    }
    if (
      message.type === RELAY_MESSAGE_TYPES_V11.runtimeEvent ||
      message.type === RELAY_MESSAGE_TYPES_V11.interactionRequest ||
      message.type === RELAY_MESSAGE_TYPES_V11.interactionResolved ||
      message.type === RELAY_MESSAGE_TYPES_V11.interactionCancelled
    ) {
      this.#acceptSequencedMessage({ relaySequence: message.relaySequence, message });
      return;
    }
    throw transportError(
      RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
      `Relay sent disallowed Browser inbound frame: ${message.type}`,
      false,
    );
  }

  #handleRuntimeResponse(
    message: Extract<RelayMessageV11, { readonly type: "runtime.response" }>,
  ): void {
    this.#assertWorkspace(message.workspaceId);
    const pending = this.#pendingRequests.get(message.requestId);
    if (pending === undefined) {
      return;
    }
    if (message.error !== undefined) {
      const safeMessage =
        message.error.code === RELAY_ERROR_CODES_V11.remoteRequestDenied
          ? "Remote request denied"
          : message.error.message;
      this.#settlePending(
        pending,
        new RelayClientError({
          kind: "remote",
          code: message.error.code,
          message: safeMessage,
          retryable: message.error.retryable,
        }),
      );
      return;
    }
    if (message.result === undefined) {
      this.#settlePending(
        pending,
        transportError(
          RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
          "runtime.response contains neither result nor error",
          false,
        ),
      );
      return;
    }
    try {
      const result = parseRelayRequestResultForVersion("1.1", pending.method, message.result);
      this.#settlePending(pending, undefined, result);
    } catch {
      this.#settlePending(
        pending,
        transportError(
          RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
          `Relay returned an invalid ${pending.method} result`,
          false,
        ),
      );
    }
  }

  #acceptSequencedMessage(sequenced: SequencedRelayMessage): void {
    this.#assertWorkspace(sequenced.message.workspaceId);
    this.#reconcileResynchronizedStream(sequenced.relaySequence);
    if (sequenced.relaySequence <= this.#lastRelaySequence) {
      this.#sendAck();
      return;
    }
    if (this.#recovering) {
      this.#sequencedBuffer.set(sequenced.relaySequence, sequenced);
      return;
    }
    if (sequenced.relaySequence !== this.#lastRelaySequence + 1) {
      this.#sequencedBuffer.set(sequenced.relaySequence, sequenced);
      // This frame exists locally; Snapshot covers only the missing prefix before it.
      this.#beginGapRecovery(sequenced.relaySequence - 1);
      return;
    }
    this.#applySequencedMessage(sequenced.message);
    this.#lastRelaySequence = sequenced.relaySequence;
    this.#sendAck();
  }

  #applySequencedMessage(message: SequencedRelayMessage["message"]): void {
    const threadId =
      message.type === RELAY_MESSAGE_TYPES_V11.runtimeEvent
        ? message.event.threadId
        : message.threadId;
    const thread = this.#getOrCreateThread(threadId);
    if (message.type === RELAY_MESSAGE_TYPES_V11.runtimeEvent) {
      thread.applyRuntimeEvent(message);
    } else if (message.type === RELAY_MESSAGE_TYPES_V11.interactionRequest) {
      thread.applyInteractionRequest(message);
    } else {
      thread.applyInteractionTerminal(message);
    }
  }

  #beginGapRecovery(throughRelaySequence: number): void {
    if (throughRelaySequence <= this.#lastRelaySequence) {
      this.#sendAck();
      return;
    }
    if (this.#recovering) {
      return;
    }
    this.#recovering = true;
    const recoveryThrough = throughRelaySequence;
    const epoch = this.#streamEpoch;
    const refreshes = [...this.#threads.values()].map(async (thread) => thread.refresh());
    Promise.all(refreshes)
      .then(() => {
        if (this.#streamEpoch !== epoch) {
          return;
        }
        this.#lastRelaySequence = recoveryThrough;
        for (const sequence of [...this.#sequencedBuffer.keys()]) {
          if (sequence <= recoveryThrough) {
            this.#sequencedBuffer.delete(sequence);
          }
        }
        this.#recovering = false;
        this.#sendAck();
        this.#drainSequencedBuffer();
      })
      .catch(() => {
        if (this.#streamEpoch !== epoch) {
          return;
        }
        this.#recovering = false;
        this.#socket?.close(
          BROWSER_LEGAL_RELAY_CLOSE_CODES.sessionRetryable,
          "snapshot recovery failed",
        );
      });
  }

  #reconcileResynchronizedStream(relaySequence: number): void {
    if (!this.#resynchronizing) {
      return;
    }
    this.#resynchronizing = false;
    if (relaySequence > this.#lastRelaySequence) {
      return;
    }
    this.#streamEpoch += 1;
    this.#lastRelaySequence = EMPTY_RELAY_SEQUENCE_CURSOR;
    this.#sequencedBuffer.clear();
    this.#recovering = false;
    this.#refreshOpenThreads();
  }

  #refreshOpenThreads(): void {
    for (const thread of this.#threads.values()) {
      thread.refresh().catch(() => undefined);
    }
  }

  #drainSequencedBuffer(): void {
    while (!this.#recovering) {
      const nextSequence = this.#lastRelaySequence + 1;
      const next = this.#sequencedBuffer.get(nextSequence);
      if (next === undefined) {
        const first = [...this.#sequencedBuffer.keys()].sort((left, right) => left - right)[0];
        if (first !== undefined && first > nextSequence) {
          // Keep the first retained frame buffered so it is applied before its sequence is ACKed.
          this.#beginGapRecovery(first - 1);
        }
        return;
      }
      this.#sequencedBuffer.delete(nextSequence);
      this.#applySequencedMessage(next.message);
      this.#lastRelaySequence = nextSequence;
      this.#sendAck();
    }
  }

  #sendAck(): void {
    const workspaceId = this.#workspaceId;
    const socket = this.#socket;
    if (workspaceId === undefined || socket?.readyState !== WEBSOCKET_OPEN_STATE) {
      return;
    }
    const frame = relayAckSchemaV11.parse({
      type: RELAY_MESSAGE_TYPES_V11.runtimeAck,
      workspaceId,
      throughRelaySequence: this.#lastRelaySequence,
    });
    socket.send(JSON.stringify(frame));
  }

  #handleUnexpectedClose(): void {
    if (this.#closedByClient || this.#permanentlyClosed) {
      return;
    }
    this.#rejectPendingQueries();
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined || this.#closedByClient || this.#permanentlyClosed) {
      return;
    }
    this.#reconnectAttempt += 1;
    const delayMs = this.#runtime.reconnectDelayMs(this.#reconnectAttempt);
    const retryAt = new Date(this.#runtime.scheduler.now() + delayMs).toISOString();
    this.#setConnectionState({
      status: "reconnecting",
      attempt: this.#reconnectAttempt,
      retryAt,
    });
    this.#reconnectTimer = this.#runtime.scheduler.setTimer(() => {
      this.#reconnectTimer = undefined;
      if (
        this.#closedByClient ||
        this.#permanentlyClosed ||
        this.#connectPromise !== undefined ||
        this.#connectionState.status === "connected"
      ) {
        return;
      }
      this.#beginSessionAttempt().catch((error: unknown) => {
        if (this.#closedByClient) {
          return;
        }
        const clientError = asRelayClientError(error);
        if (!clientError.details.retryable) {
          this.#permanentlyClosed = true;
          this.#rejectAllPending(true);
          this.#setConnectionState({ status: "closed", reason: "session" });
          return;
        }
        this.#scheduleReconnect();
      });
    }, delayMs);
  }

  #beginSessionAttempt(externalSignal?: AbortSignal, timeoutMs?: number): Promise<void> {
    const attempt = this.#openSession(externalSignal, timeoutMs).finally(() => {
      if (this.#connectPromise === attempt) {
        this.#connectPromise = undefined;
      }
    });
    this.#connectPromise = attempt;
    return attempt;
  }

  #discardSocket(reason: string): void {
    const socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    this.#socket = undefined;
    socket.close(BROWSER_LEGAL_RELAY_CLOSE_CODES.normal, reason);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) {
      return;
    }
    this.#runtime.scheduler.clearTimer(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #replayPendingMutations(): void {
    for (const pending of this.#pendingRequests.values()) {
      if (pending.mutation) {
        this.#sendPending(pending);
      }
    }
  }

  #request<TMethod extends RelayMethodV11>(
    method: TMethod,
    params: unknown,
    options?: RelayRequestOptions,
  ): Promise<RelayRequestResultForVersion<"1.1", TMethod>> {
    if (
      this.#connectionState.status !== "connected" ||
      this.#connectionState.workspaceStatus !== "online" ||
      this.#workspaceId === undefined
    ) {
      const offline =
        this.#connectionState.status === "connected" &&
        this.#connectionState.workspaceStatus === "offline";
      return Promise.reject(
        transportError(
          offline
            ? RELAY_CLIENT_TRANSPORT_ERROR_CODES.workspaceOffline
            : RELAY_CLIENT_TRANSPORT_ERROR_CODES.connectionUnavailable,
          offline ? "The local Workspace is offline" : "Relay is not connected",
          true,
        ),
      );
    }
    if (options?.signal?.aborted === true) {
      return Promise.reject(
        transportError(
          RELAY_CLIENT_TRANSPORT_ERROR_CODES.aborted,
          "Relay request was aborted",
          false,
        ),
      );
    }

    const normalizedParams = parseRelayRequestParamsForVersion("1.1", method, params);
    const requestId = relayRequestIdSchema.parse(this.#runtime.createUuid());
    const frame = relayRuntimeRequestSchemaV11.parse({
      type: RELAY_MESSAGE_TYPES_V11.runtimeRequest,
      requestId,
      workspaceId: this.#workspaceId,
      method,
      params: normalizedParams,
    });
    const timeoutMs = options?.timeoutMs ?? this.#requestTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("timeoutMs must be a positive finite number"));
    }
    const mutation = RELAY_REQUEST_METHOD_DISPOSITIONS_V11[method] === "mutation";

    return new Promise<RelayRequestResultForVersion<"1.1", TMethod>>((resolve, reject) => {
      const abortListener = options?.signal
        ? () => {
            const pending = this.#pendingRequests.get(requestId);
            if (pending === undefined) {
              return;
            }
            const unknown = pending.mutation && pending.sent;
            this.#settlePending(
              pending,
              transportError(
                unknown
                  ? RELAY_CLIENT_TRANSPORT_ERROR_CODES.outcomeUnknown
                  : RELAY_CLIENT_TRANSPORT_ERROR_CODES.aborted,
                unknown
                  ? "Mutation outcome is unknown after Browser cancellation"
                  : "Relay request was aborted",
                false,
              ),
            );
          }
        : undefined;
      const pending: PendingRequest = {
        requestId,
        method,
        frame: JSON.stringify(frame),
        mutation,
        sent: false,
        resolve: (value) => {
          resolve(value as RelayRequestResultForVersion<"1.1", TMethod>);
        },
        reject,
        signal: options?.signal,
        abortListener,
        timeoutHandle: undefined,
      };
      pending.timeoutHandle = this.#runtime.scheduler.setTimer(() => {
        const active = this.#pendingRequests.get(requestId);
        if (active === undefined) {
          return;
        }
        const unknown = active.mutation && active.sent;
        this.#settlePending(
          active,
          transportError(
            unknown
              ? RELAY_CLIENT_TRANSPORT_ERROR_CODES.outcomeUnknown
              : RELAY_CLIENT_TRANSPORT_ERROR_CODES.requestTimeout,
            unknown ? "Mutation outcome is unknown after Relay timeout" : "Relay request timed out",
            !unknown,
          ),
        );
      }, timeoutMs);
      options?.signal?.addEventListener("abort", abortListener ?? (() => undefined), {
        once: true,
      });
      this.#pendingRequests.set(requestId, pending);
      this.#sendPending(pending);
    });
  }

  #sendPending(pending: PendingRequest): void {
    const socket = this.#socket;
    if (
      socket?.readyState !== WEBSOCKET_OPEN_STATE ||
      this.#connectionState.status !== "connected" ||
      this.#connectionState.workspaceStatus !== "online"
    ) {
      return;
    }
    socket.send(pending.frame);
    pending.sent = true;
  }

  #settlePending(pending: PendingRequest, error?: RelayClientError, value?: unknown): void {
    if (!this.#pendingRequests.delete(pending.requestId)) {
      return;
    }
    if (pending.timeoutHandle !== undefined) {
      this.#runtime.scheduler.clearTimer(pending.timeoutHandle);
    }
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    if (error !== undefined) {
      pending.reject(error);
    } else {
      pending.resolve(value);
    }
  }

  #rejectPendingQueries(): void {
    for (const pending of [...this.#pendingRequests.values()]) {
      if (!pending.mutation) {
        this.#settlePending(
          pending,
          transportError(
            RELAY_CLIENT_TRANSPORT_ERROR_CODES.transportError,
            "Relay disconnected before the query completed",
            true,
          ),
        );
      }
    }
  }

  #rejectAllPending(mutationOutcomeUnknown: boolean): void {
    for (const pending of [...this.#pendingRequests.values()]) {
      const unknown = mutationOutcomeUnknown && pending.mutation && pending.sent;
      this.#settlePending(
        pending,
        transportError(
          unknown
            ? RELAY_CLIENT_TRANSPORT_ERROR_CODES.outcomeUnknown
            : RELAY_CLIENT_TRANSPORT_ERROR_CODES.closed,
          unknown ? "Mutation outcome is unknown after Relay closed" : "Relay client is closed",
          false,
        ),
      );
    }
  }

  #assertWorkspace(workspaceId: WorkspaceId): void {
    if (this.#workspaceId !== workspaceId) {
      throw transportError(
        RELAY_CLIENT_TRANSPORT_ERROR_CODES.protocolError,
        "Relay frame does not match the bound Workspace",
        false,
      );
    }
  }

  #getOrCreateThread(threadId: RelayThreadId): RelayThreadImpl {
    const existing = this.#threads.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const thread = new RelayThreadImpl(this, threadId);
    this.#threads.set(threadId, thread);
    return thread;
  }

  #setConnectionState(state: RelayConnectionState): void {
    this.#connectionState = relayConnectionStateSchema.parse(state);
    for (const listener of this.#connectionListeners) {
      notifyListener(listener, this.#connectionState);
    }
  }

  #failProtocol(error: RelayClientError): void {
    this.#permanentlyClosed = true;
    this.#rejectAllPending(true);
    for (const thread of this.#threads.values()) {
      thread.applyError(error.details);
    }
    this.#setConnectionState({ status: "closed", reason: "protocol" });
  }
}

export function createRelayClientWithRuntime(
  options: CreateRelayClientOptions,
  runtime: RelayClientRuntimeDependencies,
): RelayClient {
  return new RelayClientImpl(options, runtime);
}

export function createRelayClient(options: CreateRelayClientOptions): RelayClient {
  return createRelayClientWithRuntime(options, browserRelayRuntimeDependencies);
}
