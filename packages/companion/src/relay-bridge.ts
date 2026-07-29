import { createHash, randomUUID } from "node:crypto";
import { RollRpcError } from "@roll-agent/client-node";
import {
  RUNTIME_METHODS,
  jsonValueSchema,
  type JsonValue,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
} from "@roll-agent/protocol";
import { CompanionWorkspace } from "./companion-workspace.ts";
import {
  COMPANION_RELAY_PROTOCOL_VERSION,
  relayMessageSchema,
  relayRuntimeRequestSchema,
  type DeviceId,
  type RelayEncryptedMessage,
  type RelayMessage,
  type RelayRuntimeRequest,
  type RelayRuntimeResponse,
  type WorkspaceId,
} from "./relay-protocol.ts";

export interface RelayTransport {
  send(message: RelayMessage): void | Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface CompanionRelayBridgeOptions {
  readonly deviceId: DeviceId;
  readonly pairingToken: string;
  readonly workspaces: ReadonlyMap<WorkspaceId, CompanionWorkspace>;
  readonly ciphers?: ReadonlyMap<WorkspaceId, RelayPayloadCipher>;
  readonly maxRequestCacheEntries?: number;
}

export interface RelayPayloadCipher {
  readonly algorithm: string;
  encrypt(value: JsonValue): Promise<{
    readonly nonce: string;
    readonly ciphertext: string;
  }>;
  decrypt(message: RelayEncryptedMessage): Promise<JsonValue>;
}

interface CachedRelayResponse {
  readonly fingerprint: string;
  readonly response: Promise<RelayRuntimeResponse>;
}

interface RelayTransportGeneration {
  readonly transport: RelayTransport;
  readonly advertisedThrough: Map<WorkspaceId, number>;
  queue: Promise<void>;
}

const DEFAULT_MAX_REQUEST_CACHE_ENTRIES = 10_000;
const RELAY_ENCRYPTION_REQUIRED_ERROR = {
  code: "RELAY_ENCRYPTION_REQUIRED",
  message: "Encrypted Relay request required for this workspace",
  retryable: false,
} as const;
const MUTATION_RUNTIME_METHODS = new Set<RuntimeMethod>([
  RUNTIME_METHODS.threadCreate,
  RUNTIME_METHODS.threadRename,
  RUNTIME_METHODS.threadDelete,
  RUNTIME_METHODS.threadDetach,
  RUNTIME_METHODS.turnStart,
  RUNTIME_METHODS.turnCancel,
  RUNTIME_METHODS.approvalRespond,
]);

function relayRequestFingerprint(request: RelayRuntimeRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: request.workspaceId,
        method: request.method,
        params: request.params,
      }),
    )
    .digest("hex");
}

function toRelayError(error: unknown): NonNullable<RelayRuntimeResponse["error"]> {
  if (error instanceof RollRpcError) {
    return {
      code: error.data?.rollCode ?? `JSON_RPC_${String(error.code)}`,
      message: error.message,
      retryable: error.data?.retryable ?? false,
    };
  }
  return {
    code: error instanceof Error ? error.name : "COMPANION_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

export class CompanionRelayBridge {
  private readonly deviceId: DeviceId;
  private readonly pairingToken: string;
  private readonly workspaces: ReadonlyMap<WorkspaceId, CompanionWorkspace>;
  private readonly ciphers: ReadonlyMap<WorkspaceId, RelayPayloadCipher>;
  private readonly maxRequestCacheEntries: number;
  private readonly acknowledged = new Map<WorkspaceId, number>();
  private readonly inFlightRequestCache = new Map<string, CachedRelayResponse>();
  private readonly settledRequestCache = new Map<string, CachedRelayResponse>();
  private readonly releaseWorkspaceSubscriptions: Array<() => void>;
  private transportGeneration: RelayTransportGeneration | undefined;
  private releaseTransportSubscriptions: Array<() => void> = [];

  constructor(options: CompanionRelayBridgeOptions) {
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
        workspace.onBufferedEvent((entry) => {
          if (this.transportGeneration === undefined) {
            return;
          }
          this.sendRuntimeEvent(workspaceId, entry.relaySequence, entry.event);
        }),
    );
  }

  connect(transport: RelayTransport): void {
    this.releaseCurrentTransport(true);
    const generation: RelayTransportGeneration = {
      transport,
      advertisedThrough: new Map(),
      queue: Promise.resolve(),
    };
    this.transportGeneration = generation;
    this.releaseTransportSubscriptions = [
      transport.onMessage((message) => {
        this.handleMessage(message, generation).catch(() => undefined);
      }),
      transport.onClose(() => {
        if (this.transportGeneration === generation) {
          this.releaseCurrentTransport();
        }
      }),
    ];
    this.enqueue({
      type: "device.connect",
      protocolVersion: COMPANION_RELAY_PROTOCOL_VERSION,
      deviceId: this.deviceId,
      pairingToken: this.pairingToken,
    });
    for (const [workspaceId, workspace] of this.workspaces) {
      const replay = workspace.replay(this.acknowledged.get(workspaceId) ?? -1);
      if (replay.gap !== undefined) {
        this.enqueue({
          type: "runtime.gap",
          workspaceId,
          fromRelaySequence: replay.gap.fromRelaySequence,
          throughRelaySequence: replay.gap.throughRelaySequence,
          recovery: "thread.snapshot",
        });
      }
      for (const entry of replay.events) {
        this.sendRuntimeEvent(workspaceId, entry.relaySequence, entry.event);
      }
    }
  }

  close(): void {
    this.releaseCurrentTransport(true);
    for (const release of this.releaseWorkspaceSubscriptions) {
      release();
    }
  }

  private enqueue(message: RelayMessage): void {
    const generation = this.transportGeneration;
    if (generation === undefined) {
      return;
    }
    this.enqueueTask(generation, async () => {
      await generation.transport.send(message);
      if (this.transportGeneration !== generation) return;
      if (message.type === "runtime.event") {
        this.markAdvertised(generation, message.workspaceId, message.relaySequence);
      } else if (message.type === "runtime.gap") {
        this.markAdvertised(generation, message.workspaceId, message.throughRelaySequence);
      }
    });
  }

  private enqueueTask(generation: RelayTransportGeneration, task: () => Promise<void>): void {
    generation.queue = generation.queue
      .then(async () => {
        if (this.transportGeneration === generation) {
          await task();
        }
      })
      .catch(() => {
        // The event remains in the workspace buffer and is replayed after reconnect.
      });
  }

  private async handleMessage(
    value: unknown,
    generation: RelayTransportGeneration,
    decryptedWithWorkspaceCipher = false,
  ): Promise<void> {
    if (this.transportGeneration !== generation) {
      return;
    }
    const parsed = relayMessageSchema.safeParse(value);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === "runtime.encrypted") {
      if (message.payloadKind !== "request" || message.requestId === undefined) {
        return;
      }
      const cipher = this.ciphers.get(message.workspaceId);
      if (cipher === undefined) {
        return;
      }
      try {
        const decrypted = relayRuntimeRequestSchema.parse(await cipher.decrypt(message));
        if (
          decrypted.workspaceId !== message.workspaceId ||
          decrypted.requestId !== message.requestId
        ) {
          return;
        }
        await this.handleMessage(decrypted, generation, true);
      } catch {
        this.sendRuntimeResponse({
          type: "runtime.response",
          requestId: message.requestId,
          workspaceId: message.workspaceId,
          error: {
            code: "ENCRYPTED_PAYLOAD_INVALID",
            message: "Encrypted Relay payload could not be authenticated or parsed",
            retryable: false,
          },
        });
      }
      return;
    }
    if (message.type === "runtime.ack") {
      const workspace = this.workspaces.get(message.workspaceId);
      if (
        workspace === undefined ||
        message.throughRelaySequence > (generation.advertisedThrough.get(message.workspaceId) ?? -1)
      ) {
        return;
      }
      const current = this.acknowledged.get(message.workspaceId) ?? -1;
      if (message.throughRelaySequence > current) {
        this.acknowledged.set(message.workspaceId, message.throughRelaySequence);
        workspace.acknowledge(message.throughRelaySequence);
      }
      return;
    }
    if (message.type !== "runtime.request") {
      return;
    }
    if (!decryptedWithWorkspaceCipher && this.ciphers.has(message.workspaceId)) {
      this.sendRuntimeResponse({
        type: "runtime.response",
        requestId: message.requestId,
        workspaceId: message.workspaceId,
        error: RELAY_ENCRYPTION_REQUIRED_ERROR,
      });
      return;
    }
    const workspace = this.workspaces.get(message.workspaceId);
    if (workspace === undefined) {
      this.sendRuntimeResponse({
        type: "runtime.response",
        requestId: message.requestId,
        workspaceId: message.workspaceId,
        error: {
          code: "WORKSPACE_NOT_FOUND",
          message: "The requested workspace is not paired with this Companion",
          retryable: false,
        },
      });
      return;
    }
    const response = await this.resolveRuntimeRequest(message, workspace);
    this.sendRuntimeResponse(response);
  }

  private resolveRuntimeRequest(
    request: RelayRuntimeRequest,
    workspace: CompanionWorkspace,
  ): Promise<RelayRuntimeResponse> {
    const key = `${request.workspaceId}:${request.requestId}`;
    const inFlight = this.inFlightRequestCache.get(key);
    const settled = this.settledRequestCache.get(key);
    const existing = inFlight ?? settled;
    if (existing !== undefined) {
      const fingerprint = relayRequestFingerprint(request);
      if (existing.fingerprint === fingerprint) {
        if (settled !== undefined) {
          this.settledRequestCache.delete(key);
          this.settledRequestCache.set(key, settled);
        }
        return existing.response;
      }
      return Promise.resolve({
        type: "runtime.response",
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        error: {
          code: "RELAY_REQUEST_ID_CONFLICT",
          message: "Relay requestId was reused with different method or params",
          retryable: false,
        },
      });
    }
    if (!MUTATION_RUNTIME_METHODS.has(request.method)) {
      return this.executeRuntimeRequest(request, workspace);
    }
    const fingerprint = relayRequestFingerprint(request);
    const entry: CachedRelayResponse = {
      fingerprint,
      response: this.executeRuntimeRequest(request, workspace),
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
    request: RelayRuntimeRequest,
    workspace: CompanionWorkspace,
  ): Promise<RelayRuntimeResponse> {
    try {
      const result = await workspace.handleRemoteRequest(request);
      return {
        type: "runtime.response",
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        result: jsonValueSchema.parse(result),
      };
    } catch (error: unknown) {
      return {
        type: "runtime.response",
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        error: toRelayError(error),
      };
    }
  }

  private settleRequest(key: string, entry: CachedRelayResponse): void {
    if (this.inFlightRequestCache.get(key) !== entry) {
      return;
    }
    this.inFlightRequestCache.delete(key);
    this.settledRequestCache.set(key, entry);
    while (this.settledRequestCache.size > this.maxRequestCacheEntries) {
      const oldestKey = this.settledRequestCache.keys().next().value;
      if (oldestKey === undefined) return;
      this.settledRequestCache.delete(oldestKey);
    }
  }

  private sendRuntimeEvent(
    workspaceId: WorkspaceId,
    relaySequence: number,
    event: RuntimeEventEnvelope,
  ): void {
    const cipher = this.ciphers.get(workspaceId);
    if (cipher === undefined) {
      this.enqueue({
        type: "runtime.event",
        workspaceId,
        relaySequence,
        event,
      });
      return;
    }
    const generation = this.transportGeneration;
    if (generation === undefined) {
      return;
    }
    this.enqueueTask(generation, async () => {
      const encrypted = await cipher.encrypt(jsonValueSchema.parse(event));
      if (this.transportGeneration !== generation) return;
      await generation.transport.send({
        type: "runtime.encrypted",
        workspaceId,
        envelopeId: randomUUID(),
        payloadKind: "event",
        relaySequence,
        algorithm: cipher.algorithm,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
      });
      if (this.transportGeneration === generation) {
        this.markAdvertised(generation, workspaceId, relaySequence);
      }
    });
  }

  private sendRuntimeResponse(response: RelayRuntimeResponse): void {
    const cipher = this.ciphers.get(response.workspaceId);
    if (cipher === undefined) {
      this.enqueue(response);
      return;
    }
    const generation = this.transportGeneration;
    if (generation === undefined) {
      return;
    }
    this.enqueueTask(generation, async () => {
      const encrypted = await cipher.encrypt(jsonValueSchema.parse(response));
      if (this.transportGeneration !== generation) return;
      await generation.transport.send({
        type: "runtime.encrypted",
        workspaceId: response.workspaceId,
        envelopeId: randomUUID(),
        payloadKind: "response",
        requestId: response.requestId,
        algorithm: cipher.algorithm,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
      });
    });
  }

  private releaseCurrentTransport(close = false): void {
    const current = this.transportGeneration;
    this.transportGeneration = undefined;
    for (const release of this.releaseTransportSubscriptions) {
      release();
    }
    this.releaseTransportSubscriptions = [];
    if (close) {
      current?.transport.close();
    }
  }

  private markAdvertised(
    generation: RelayTransportGeneration,
    workspaceId: WorkspaceId,
    relaySequence: number,
  ): void {
    generation.advertisedThrough.set(
      workspaceId,
      Math.max(generation.advertisedThrough.get(workspaceId) ?? -1, relaySequence),
    );
  }
}

export interface WebSocketMessageEventLike {
  readonly data: unknown;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
}

export function createWebSocketRelayTransport(socket: WebSocketLike): RelayTransport {
  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    onMessage(listener) {
      const handler = (event: WebSocketMessageEventLike) => {
        if (typeof event.data !== "string") {
          return;
        }
        try {
          listener(JSON.parse(event.data));
        } catch {
          // Invalid relay frames are ignored; the authenticated Relay owns protocol diagnostics.
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

export interface OutboundCompanionRelayOptions {
  readonly bridge: CompanionRelayBridge;
  readonly connectTransport: () => Promise<RelayTransport>;
  readonly minReconnectMs?: number;
  readonly maxReconnectMs?: number;
}

export class OutboundCompanionRelay {
  private readonly bridge: CompanionRelayBridge;
  private readonly connectTransport: () => Promise<RelayTransport>;
  private readonly minReconnectMs: number;
  private readonly maxReconnectMs: number;
  private reconnectMs: number;
  private timer: NodeJS.Timeout | undefined;
  private transport: RelayTransport | undefined;
  private stopped = true;
  private connecting = false;

  constructor(options: OutboundCompanionRelayOptions) {
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
      const transport = await this.connectTransport();
      if (this.stopped) {
        transport.close();
        return;
      }
      this.transport = transport;
      this.reconnectMs = this.minReconnectMs;
      transport.onClose(() => {
        if (this.transport === transport) {
          this.transport = undefined;
          this.scheduleReconnect();
        }
      });
      this.bridge.connect(transport);
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

export function relayEventMessage(
  workspaceId: WorkspaceId,
  relaySequence: number,
  event: RuntimeEventEnvelope,
): RelayMessage {
  return {
    type: "runtime.event",
    workspaceId,
    relaySequence,
    event,
  };
}
