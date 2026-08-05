import { createHash, randomUUID } from "node:crypto";
import { RollRpcError } from "@roll-agent/client-node";
import { jsonValueSchema, type JsonValue } from "@roll-agent/protocol";
import {
  RELAY_ERROR_CODES,
  RELAY_MESSAGE_TYPES_V11,
  RELAY_REQUEST_METHODS_V11,
  canonicalizeRelayJson,
  classifyRelayAck,
  getRelayErrorRetryability,
  getRelayRequestMethodDispositionForVersion,
  parseRelayRequestParamsForVersion,
  parseRelayRequestResultForVersion,
  projectRelayOperationGetResultV11,
  projectRelayThreadSnapshotV11,
  relayEnvelopeIdSchema,
  relayMessageSchemaV11,
  relayRuntimeRequestSchemaV11,
  type DeviceId,
  type RelayEncryptedMessageV11,
  type RelayMessageV11,
  type RelayRuntimeRequestV11,
  type WorkspaceId,
} from "@roll-agent/relay-protocol";
import { LocalApprovalDeniedError, LocalConfirmationRequiredError } from "./companion-workspace.ts";
import type {
  RemoteInteractionCandidateContext,
  RemoteInteractionResponderPolicy,
} from "./interaction-broker.ts";
import {
  materializeRelayFrameV11,
  type CompanionRelayFrameEntryV11,
  type CompanionRelayFrameReplayV11,
} from "./relay-frame-buffer.ts";

type RelayRuntimeResponseV11 = Extract<RelayMessageV11, { readonly type: "runtime.response" }>;

export interface RelayTransportV11 {
  send(message: RelayMessageV11): void | Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface RelayPayloadCipherV11 {
  readonly algorithm: string;
  encrypt(value: JsonValue): Promise<{
    readonly nonce: string;
    readonly ciphertext: string;
  }>;
  decrypt(message: RelayEncryptedMessageV11): Promise<JsonValue>;
}

export interface CompanionWorkspaceV11Port {
  onBufferedRelayFrameV11(listener: (entry: CompanionRelayFrameEntryV11) => void): () => void;
  replayRelayFramesV11(afterRelaySequence?: number): CompanionRelayFrameReplayV11;
  acknowledgeRelayFramesV11(throughRelaySequence: number): void;
  handleRemoteRequestV11(
    request: RelayRuntimeRequestV11,
    context: RemoteInteractionCandidateContext,
  ): Promise<unknown>;
  closeRemoteInteractions?(reason: Error): void;
}

export interface CompanionRelayBridgeV11Options {
  readonly deviceId: DeviceId;
  readonly pairingToken: string;
  readonly workspaces: ReadonlyMap<WorkspaceId, CompanionWorkspaceV11Port>;
  readonly ciphers?: ReadonlyMap<WorkspaceId, RelayPayloadCipherV11>;
  readonly maxRequestCacheEntries?: number;
}

export interface CompanionRelayConnectionV11Options {
  readonly responderPolicy: RemoteInteractionResponderPolicy;
  /**
   * Opaque host-owned authentication/session state. The Companion never interprets this value
   * and does not claim that its presence authenticates a Browser or elects a controller.
   */
  readonly responderContext: unknown;
}

interface CachedRelayResponseV11 {
  readonly fingerprint: string;
  readonly response: Promise<RelayRuntimeResponseV11>;
  /** Only candidate mutations are scoped to the authenticated transport generation. */
  readonly generation: RelayTransportGenerationV11 | undefined;
}

interface RelayTransportGenerationV11 {
  readonly transport: RelayTransportV11;
  readonly responderPolicy: RemoteInteractionResponderPolicy;
  readonly responderContext: unknown;
  readonly controller: AbortController;
  readonly advertisedThrough: Map<WorkspaceId, number>;
  queue: Promise<void>;
}

class InvalidRelayRequestParamsV11Error extends Error {
  constructor() {
    super("Invalid Relay Wire 1.1 request params");
    this.name = "InvalidRelayRequestParamsV11Error";
  }
}

class LocalOnlyRelayRequestV11Error extends Error {
  constructor(method: string) {
    super(`Relay method "${method}" is owned by the local Companion`);
    this.name = "LocalOnlyRelayRequestV11Error";
  }
}

const DEFAULT_MAX_REQUEST_CACHE_ENTRIES = 10_000;
const RELAY_ENCRYPTION_REQUIRED_ERROR = {
  code: RELAY_ERROR_CODES.encryptionRequired,
  message: "Encrypted Relay request required for this workspace",
  retryable: getRelayErrorRetryability(RELAY_ERROR_CODES.encryptionRequired),
} as const;

function relayRequestFingerprintV11(request: RelayRuntimeRequestV11): string {
  const identity: JsonValue = {
    workspaceId: request.workspaceId,
    method: request.method,
    params: request.params,
  };
  return createHash("sha256").update(canonicalizeRelayJson(identity)).digest("hex");
}

function projectRelayRuntimeResultV11(request: RelayRuntimeRequestV11, value: unknown): JsonValue {
  let projected = value;
  if (
    request.method === RELAY_REQUEST_METHODS_V11.threadOpen ||
    request.method === RELAY_REQUEST_METHODS_V11.threadSnapshot
  ) {
    projected = projectRelayThreadSnapshotV11(value);
  } else if (request.method === RELAY_REQUEST_METHODS_V11.operationGet) {
    projected = projectRelayOperationGetResultV11(value);
  }
  return jsonValueSchema.parse(parseRelayRequestResultForVersion("1.1", request.method, projected));
}

function toRelayErrorV11(error: unknown): NonNullable<RelayRuntimeResponseV11["error"]> {
  if (error instanceof InvalidRelayRequestParamsV11Error) {
    return {
      code: RELAY_ERROR_CODES.invalidParams,
      message: "Invalid Relay request params",
      retryable: getRelayErrorRetryability(RELAY_ERROR_CODES.invalidParams),
    };
  }
  if (error instanceof RollRpcError) {
    return {
      code: error.data?.rollCode ?? `JSON_RPC_${String(error.code)}`,
      message: "Runtime request failed",
      retryable: error.data?.retryable ?? false,
    };
  }
  if (
    error instanceof LocalApprovalDeniedError ||
    error instanceof LocalConfirmationRequiredError ||
    (error instanceof Error &&
      (error.name === "LocalApprovalDeniedError" ||
        error.name === "LocalConfirmationRequiredError"))
  ) {
    const code =
      error instanceof LocalApprovalDeniedError || error.name === "LocalApprovalDeniedError"
        ? RELAY_ERROR_CODES.localApprovalDenied
        : RELAY_ERROR_CODES.localConfirmationRequired;
    return {
      code,
      message:
        code === RELAY_ERROR_CODES.localApprovalDenied
          ? "Local approval denied"
          : "Local confirmation required",
      retryable: getRelayErrorRetryability(code),
    };
  }
  return {
    code: RELAY_ERROR_CODES.companionError,
    message: "Companion request failed",
    retryable: getRelayErrorRetryability(RELAY_ERROR_CODES.companionError),
  };
}

/**
 * Explicit Relay Wire 1.1 bridge. The legacy `CompanionRelayBridge.connect(transport)` API remains
 * a frozen Wire 1.0 path; callers must opt into this class to project typed Interactions.
 */
export class CompanionRelayBridgeV11 {
  private readonly deviceId: DeviceId;
  private readonly pairingToken: string;
  private readonly workspaces: ReadonlyMap<WorkspaceId, CompanionWorkspaceV11Port>;
  private readonly ciphers: ReadonlyMap<WorkspaceId, RelayPayloadCipherV11>;
  private readonly maxRequestCacheEntries: number;
  private readonly acknowledged = new Map<WorkspaceId, number>();
  private readonly inFlightRequestCache = new Map<string, CachedRelayResponseV11>();
  private readonly settledRequestCache = new Map<string, CachedRelayResponseV11>();
  private readonly releaseWorkspaceSubscriptions: Array<() => void>;
  private generation: RelayTransportGenerationV11 | undefined;
  private releaseTransportSubscriptions: Array<() => void> = [];
  private closed = false;

  constructor(options: CompanionRelayBridgeV11Options) {
    this.deviceId = options.deviceId;
    this.pairingToken = options.pairingToken;
    this.workspaces = options.workspaces;
    this.ciphers = options.ciphers ?? new Map();
    this.maxRequestCacheEntries =
      options.maxRequestCacheEntries ?? DEFAULT_MAX_REQUEST_CACHE_ENTRIES;
    if (!Number.isInteger(this.maxRequestCacheEntries) || this.maxRequestCacheEntries < 1) {
      throw new Error("maxRequestCacheEntries must be a positive integer");
    }
    this.releaseWorkspaceSubscriptions = [...this.workspaces.entries()].map(
      ([workspaceId, workspace]) =>
        workspace.onBufferedRelayFrameV11((entry) => {
          const generation = this.generation;
          if (generation !== undefined) {
            this.sendFrame(generation, workspaceId, entry);
          }
        }),
    );
  }

  connect(transport: RelayTransportV11, options: CompanionRelayConnectionV11Options): void {
    if (this.closed) {
      throw new Error("Companion Relay Wire 1.1 bridge is closed");
    }
    this.releaseCurrentGeneration(true);
    const generation: RelayTransportGenerationV11 = {
      transport,
      responderPolicy: options.responderPolicy,
      responderContext: options.responderContext,
      controller: new AbortController(),
      advertisedThrough: new Map(),
      queue: Promise.resolve(),
    };
    this.generation = generation;
    this.releaseTransportSubscriptions = [
      transport.onMessage((message) => {
        this.handleMessage(message, generation).catch(() => undefined);
      }),
      transport.onClose(() => {
        if (this.generation === generation) {
          this.releaseCurrentGeneration();
        }
      }),
    ];
    this.enqueue(generation, {
      type: RELAY_MESSAGE_TYPES_V11.deviceConnect,
      protocolVersion: "1.1",
      deviceId: this.deviceId,
      pairingToken: this.pairingToken,
    });
    for (const [workspaceId, workspace] of this.workspaces) {
      const replay = workspace.replayRelayFramesV11(this.acknowledged.get(workspaceId) ?? -1);
      if (replay.gap !== undefined) {
        this.enqueue(generation, {
          type: RELAY_MESSAGE_TYPES_V11.runtimeGap,
          workspaceId,
          fromRelaySequence: replay.gap.fromRelaySequence,
          throughRelaySequence: replay.gap.throughRelaySequence,
          recovery: "thread.snapshot",
        });
      }
      for (const entry of replay.frames) {
        this.sendFrame(generation, workspaceId, entry);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.releaseCurrentGeneration(true);
    for (const release of this.releaseWorkspaceSubscriptions) {
      release();
    }
    const reason = new Error("Companion Relay Wire 1.1 bridge closed");
    for (const workspace of this.workspaces.values()) {
      workspace.closeRemoteInteractions?.(reason);
    }
  }

  private enqueue(generation: RelayTransportGenerationV11, message: RelayMessageV11): void {
    this.enqueueTask(generation, async () => {
      await generation.transport.send(message);
      if (this.generation !== generation) {
        return;
      }
      this.markMessageAdvertised(generation, message);
    });
  }

  private enqueueTask(generation: RelayTransportGenerationV11, task: () => Promise<void>): void {
    generation.queue = generation.queue
      .then(async () => {
        if (this.generation === generation) {
          await task();
        }
      })
      .catch(() => {
        this.failGeneration(generation);
      });
  }

  private failGeneration(generation: RelayTransportGenerationV11): void {
    if (this.generation !== generation) {
      return;
    }
    this.releaseCurrentGeneration();
    try {
      generation.transport.close();
    } catch {
      // The failed in-memory generation is detached; an explicit reconnect can replay its prefix.
    }
  }

  private async handleMessage(
    value: unknown,
    generation: RelayTransportGenerationV11,
    decryptedWithWorkspaceCipher = false,
  ): Promise<void> {
    if (this.generation !== generation) {
      return;
    }
    const parsed = relayMessageSchemaV11.safeParse(value);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === RELAY_MESSAGE_TYPES_V11.runtimeEncrypted) {
      if (message.payloadKind !== "request" || message.requestId === undefined) {
        return;
      }
      const cipher = this.ciphers.get(message.workspaceId);
      if (cipher === undefined) {
        return;
      }
      try {
        const decrypted = relayRuntimeRequestSchemaV11.parse(await cipher.decrypt(message));
        if (
          decrypted.workspaceId !== message.workspaceId ||
          decrypted.requestId !== message.requestId
        ) {
          return;
        }
        await this.handleMessage(decrypted, generation, true);
      } catch {
        this.sendRuntimeResponse(generation, {
          type: RELAY_MESSAGE_TYPES_V11.runtimeResponse,
          requestId: message.requestId,
          workspaceId: message.workspaceId,
          error: {
            code: RELAY_ERROR_CODES.encryptedPayloadInvalid,
            message: "Encrypted Relay payload could not be authenticated or parsed",
            retryable: getRelayErrorRetryability(RELAY_ERROR_CODES.encryptedPayloadInvalid),
          },
        });
      }
      return;
    }
    if (message.type === RELAY_MESSAGE_TYPES_V11.runtimeAck) {
      const workspace = this.workspaces.get(message.workspaceId);
      if (workspace === undefined) {
        return;
      }
      const current = this.acknowledged.get(message.workspaceId) ?? -1;
      const disposition = classifyRelayAck({
        acknowledgedThrough: current,
        advertisedThrough: generation.advertisedThrough.get(message.workspaceId) ?? -1,
        incomingThrough: message.throughRelaySequence,
      });
      if (disposition === "advance") {
        this.acknowledged.set(message.workspaceId, message.throughRelaySequence);
        workspace.acknowledgeRelayFramesV11(message.throughRelaySequence);
      }
      return;
    }
    if (message.type !== RELAY_MESSAGE_TYPES_V11.runtimeRequest) {
      return;
    }
    if (!decryptedWithWorkspaceCipher && this.ciphers.has(message.workspaceId)) {
      this.sendRuntimeResponse(generation, {
        type: RELAY_MESSAGE_TYPES_V11.runtimeResponse,
        requestId: message.requestId,
        workspaceId: message.workspaceId,
        error: RELAY_ENCRYPTION_REQUIRED_ERROR,
      });
      return;
    }
    const workspace = this.workspaces.get(message.workspaceId);
    if (workspace === undefined) {
      this.sendRuntimeResponse(generation, {
        type: RELAY_MESSAGE_TYPES_V11.runtimeResponse,
        requestId: message.requestId,
        workspaceId: message.workspaceId,
        error: {
          code: RELAY_ERROR_CODES.workspaceNotFound,
          message: "The requested workspace is not paired with this Companion",
          retryable: getRelayErrorRetryability(RELAY_ERROR_CODES.workspaceNotFound),
        },
      });
      return;
    }
    const response = await this.resolveRuntimeRequest(message, workspace, generation);
    if (this.generation === generation) {
      this.sendRuntimeResponse(generation, response);
    }
  }

  private resolveRuntimeRequest(
    request: RelayRuntimeRequestV11,
    workspace: CompanionWorkspaceV11Port,
    generation: RelayTransportGenerationV11,
  ): Promise<RelayRuntimeResponseV11> {
    const key = `${request.workspaceId}:${request.requestId}`;
    const inFlight = this.inFlightRequestCache.get(key);
    const settled = this.settledRequestCache.get(key);
    const existing = inFlight ?? settled;
    if (existing !== undefined) {
      const fingerprint = relayRequestFingerprintV11(request);
      if (existing.fingerprint === fingerprint) {
        if (settled !== undefined) {
          this.settledRequestCache.delete(key);
          this.settledRequestCache.set(key, settled);
        }
        return existing.response;
      }
      return Promise.resolve({
        type: RELAY_MESSAGE_TYPES_V11.runtimeResponse,
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        error: {
          code: RELAY_ERROR_CODES.requestIdConflict,
          message: "Relay requestId was reused with different method or params",
          retryable: getRelayErrorRetryability(RELAY_ERROR_CODES.requestIdConflict),
        },
      });
    }
    const disposition = getRelayRequestMethodDispositionForVersion("1.1", request.method);
    if (disposition !== "mutation") {
      return this.executeRuntimeRequest(request, workspace, generation);
    }
    const entry: CachedRelayResponseV11 = {
      fingerprint: relayRequestFingerprintV11(request),
      response: this.executeRuntimeRequest(request, workspace, generation),
      generation:
        request.method === RELAY_REQUEST_METHODS_V11.interactionCandidate ? generation : undefined,
    };
    this.inFlightRequestCache.set(key, entry);
    entry.response
      .then(
        () => this.settleRequest(key, entry),
        () => this.settleRequest(key, entry),
      )
      .catch(() => undefined);
    return entry.response;
  }

  private async executeRuntimeRequest(
    request: RelayRuntimeRequestV11,
    workspace: CompanionWorkspaceV11Port,
    generation: RelayTransportGenerationV11,
  ): Promise<RelayRuntimeResponseV11> {
    try {
      if (getRelayRequestMethodDispositionForVersion("1.1", request.method) === "local-only") {
        throw new LocalOnlyRelayRequestV11Error(request.method);
      }
      let params: JsonValue;
      try {
        params = jsonValueSchema.parse(
          parseRelayRequestParamsForVersion("1.1", request.method, request.params),
        );
      } catch {
        throw new InvalidRelayRequestParamsV11Error();
      }
      const normalizedRequest = relayRuntimeRequestSchemaV11.parse({ ...request, params });
      const context: RemoteInteractionCandidateContext = {
        signal: generation.controller.signal,
        responderPolicy: generation.responderPolicy,
        responderContext: generation.responderContext,
        workspaceId: request.workspaceId,
        requestId: request.requestId,
      };
      const result = await workspace.handleRemoteRequestV11(normalizedRequest, context);
      return {
        type: RELAY_MESSAGE_TYPES_V11.runtimeResponse,
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        result: projectRelayRuntimeResultV11(normalizedRequest, result),
      };
    } catch (error: unknown) {
      return {
        type: RELAY_MESSAGE_TYPES_V11.runtimeResponse,
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        error: toRelayErrorV11(error),
      };
    }
  }

  private settleRequest(key: string, entry: CachedRelayResponseV11): void {
    if (this.inFlightRequestCache.get(key) !== entry) {
      return;
    }
    this.inFlightRequestCache.delete(key);
    this.settledRequestCache.set(key, entry);
    while (this.settledRequestCache.size > this.maxRequestCacheEntries) {
      const oldestKey = this.settledRequestCache.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.settledRequestCache.delete(oldestKey);
    }
  }

  private sendFrame(
    generation: RelayTransportGenerationV11,
    workspaceId: WorkspaceId,
    entry: CompanionRelayFrameEntryV11,
  ): void {
    const message = materializeRelayFrameV11(workspaceId, entry);
    const cipher = this.ciphers.get(workspaceId);
    if (cipher === undefined) {
      this.enqueue(generation, message);
      return;
    }
    this.enqueueTask(generation, async () => {
      const encrypted = await cipher.encrypt(jsonValueSchema.parse(message));
      if (this.generation !== generation) {
        return;
      }
      const payloadKind =
        message.type === RELAY_MESSAGE_TYPES_V11.runtimeEvent ? "event" : "interaction";
      await generation.transport.send({
        type: RELAY_MESSAGE_TYPES_V11.runtimeEncrypted,
        workspaceId,
        envelopeId: relayEnvelopeIdSchema.parse(randomUUID()),
        payloadKind,
        relaySequence: entry.relaySequence,
        algorithm: cipher.algorithm,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
      });
      if (this.generation === generation) {
        this.markAdvertised(generation, workspaceId, entry.relaySequence);
      }
    });
  }

  private sendRuntimeResponse(
    generation: RelayTransportGenerationV11,
    response: RelayRuntimeResponseV11,
  ): void {
    const cipher = this.ciphers.get(response.workspaceId);
    if (cipher === undefined) {
      this.enqueue(generation, response);
      return;
    }
    this.enqueueTask(generation, async () => {
      const encrypted = await cipher.encrypt(jsonValueSchema.parse(response));
      if (this.generation !== generation) {
        return;
      }
      await generation.transport.send({
        type: RELAY_MESSAGE_TYPES_V11.runtimeEncrypted,
        workspaceId: response.workspaceId,
        envelopeId: relayEnvelopeIdSchema.parse(randomUUID()),
        payloadKind: "response",
        requestId: response.requestId,
        algorithm: cipher.algorithm,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
      });
    });
  }

  private releaseCurrentGeneration(closeTransport = false): void {
    const current = this.generation;
    this.generation = undefined;
    current?.controller.abort(new Error("Relay transport generation ended"));
    if (current !== undefined) {
      for (const [key, entry] of this.inFlightRequestCache) {
        if (entry.generation === current) {
          this.inFlightRequestCache.delete(key);
        }
      }
    }
    for (const release of this.releaseTransportSubscriptions) {
      release();
    }
    this.releaseTransportSubscriptions = [];
    if (closeTransport) {
      current?.transport.close();
    }
  }

  private markMessageAdvertised(
    generation: RelayTransportGenerationV11,
    message: RelayMessageV11,
  ): void {
    if (message.type === RELAY_MESSAGE_TYPES_V11.runtimeGap) {
      this.markAdvertised(generation, message.workspaceId, message.throughRelaySequence);
      return;
    }
    if (
      message.type === RELAY_MESSAGE_TYPES_V11.runtimeEvent ||
      message.type === RELAY_MESSAGE_TYPES_V11.interactionRequest ||
      message.type === RELAY_MESSAGE_TYPES_V11.interactionResolved ||
      message.type === RELAY_MESSAGE_TYPES_V11.interactionCancelled
    ) {
      this.markAdvertised(generation, message.workspaceId, message.relaySequence);
    }
  }

  private markAdvertised(
    generation: RelayTransportGenerationV11,
    workspaceId: WorkspaceId,
    relaySequence: number,
  ): void {
    generation.advertisedThrough.set(
      workspaceId,
      Math.max(generation.advertisedThrough.get(workspaceId) ?? -1, relaySequence),
    );
  }
}

export interface WebSocketMessageEventLikeV11 {
  readonly data: unknown;
}

export interface WebSocketLikeV11 {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEventLikeV11) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: WebSocketMessageEventLikeV11) => void,
  ): void;
  removeEventListener(type: "close", listener: () => void): void;
}

export function createWebSocketRelayTransportV11(socket: WebSocketLikeV11): RelayTransportV11 {
  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    onMessage(listener) {
      const handler = (event: WebSocketMessageEventLikeV11) => {
        if (typeof event.data !== "string") {
          return;
        }
        try {
          listener(JSON.parse(event.data));
        } catch {
          // Invalid Relay frames are ignored; the authenticated host owns diagnostics.
        }
      };
      socket.addEventListener("message", handler);
      return () => socket.removeEventListener("message", handler);
    },
    onClose(listener) {
      socket.addEventListener("close", listener);
      return () => socket.removeEventListener("close", listener);
    },
    close() {
      socket.close();
    },
  };
}

export interface OutboundCompanionRelayV11Connection {
  readonly transport: RelayTransportV11;
  readonly responderPolicy: RemoteInteractionResponderPolicy;
  readonly responderContext: unknown;
}

export interface OutboundCompanionRelayV11Options {
  readonly bridge: CompanionRelayBridgeV11;
  readonly connectTransport: () => Promise<OutboundCompanionRelayV11Connection>;
  readonly minReconnectMs?: number;
  readonly maxReconnectMs?: number;
}

export class OutboundCompanionRelayV11 {
  private readonly bridge: CompanionRelayBridgeV11;
  private readonly connectTransport: () => Promise<OutboundCompanionRelayV11Connection>;
  private readonly minReconnectMs: number;
  private readonly maxReconnectMs: number;
  private reconnectMs: number;
  private timer: NodeJS.Timeout | undefined;
  private transport: RelayTransportV11 | undefined;
  private stopped = true;
  private connecting = false;

  constructor(options: OutboundCompanionRelayV11Options) {
    this.bridge = options.bridge;
    this.connectTransport = options.connectTransport;
    this.minReconnectMs = options.minReconnectMs ?? 500;
    this.maxReconnectMs = options.maxReconnectMs ?? 30_000;
    this.reconnectMs = this.minReconnectMs;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.transport?.close();
    this.transport = undefined;
    this.bridge.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      const connection = await this.connectTransport();
      if (this.stopped) {
        connection.transport.close();
        return;
      }
      this.transport = connection.transport;
      this.reconnectMs = this.minReconnectMs;
      connection.transport.onClose(() => {
        if (this.transport === connection.transport) {
          this.transport = undefined;
          this.scheduleReconnect();
        }
      });
      this.bridge.connect(connection.transport, {
        responderPolicy: connection.responderPolicy,
        responderContext: connection.responderContext,
      });
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== undefined) {
      return;
    }
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect().catch(() => undefined);
    }, delay);
  }
}
