import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import clientNodePackage from "../package.json" with { type: "json" };
import {
  RuntimeEventRecoveryError,
  RuntimeEventRecoveryManager,
  type RuntimeEventRecoveryManagerOptions,
  type RuntimeEventRecoverySnapshot,
} from "./runtime-event-recovery.ts";
import {
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  RUNTIME_SERVER_REQUEST_METHODS,
  RUNTIME_V13_MIN_CLIENT_FRAME_BYTES,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  getRuntimeProtocolCapabilities,
  getRuntimeProtocolRegistry,
  interactionIdSchema,
  isRuntimeServerRequestMethodAvailable,
  isLatestRuntimeServerRequestMethod,
  isRuntimeServerRequestMethodRequired,
  parseRuntimeMethodParams,
  parseRuntimeMethodParamsForVersion,
  parseRuntimeMethodResult,
  parseRuntimeMethodResultForVersion,
  parseRuntimeProtocolErrorDataForVersion,
  parseRuntimeServerRequestCancelParamsForVersion,
  parseRuntimeServerRequestParamsForVersion,
  parseRuntimeServerRequestResultForVersion,
  initializeResultSchema,
  runtimeEventEnvelopeSchema,
  type ClientCapabilitiesSetResult,
  type InitializeResult,
  type InteractionId,
  type JsonRpcId,
  type JsonRpcMessage,
  type LatestRuntimeMethod,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodInput,
  type RuntimeMethodInputForVersion,
  type RuntimeMethodParamsForVersion,
  type RuntimeMethodResultForVersion,
  type RuntimeProtocolErrorDataForVersion,
  type RuntimeProtocolVersion,
  type RuntimeServerRequestMethod,
  type RuntimeServerRequestParamsForSupportedVersions,
  type RuntimeServerRequestResultForSupportedVersions,
  type ThreadId,
  type TurnId,
} from "@roll-agent/protocol";

export {
  DEFAULT_RUNTIME_EVENT_RECOVERY_MAX_BUFFERED_BYTES,
  DEFAULT_RUNTIME_EVENT_RECOVERY_MAX_BUFFERED_EVENTS,
  RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS,
  RuntimeEventRecoveryError,
  RuntimeEventRecoveryManager,
  type RuntimeDurableEventEnvelope,
  type RuntimeEphemeralEventEnvelope,
  type RuntimeEventRecoveryBridge,
  type RuntimeEventRecoveryCheckpoint,
  type RuntimeEventRecoveryErrorContext,
  type RuntimeEventRecoveryManagerOptions,
  type RuntimeEventRecoveryMode,
  type RuntimeEventRecoverySnapshot,
  type RuntimeEventRecoverySnapshotContext,
  type RuntimeEventRecoverySnapshotReason,
  type RuntimeEventRecoveryStartResult,
  type RuntimeEventRecoveryThreadOptions,
} from "./runtime-event-recovery.ts";

const DEFAULT_MAX_FRAME_BYTES = RUNTIME_V13_MIN_CLIENT_FRAME_BYTES;
const DEFAULT_MAX_READ_RETRIES = 1;
const DEFAULT_READ_RETRY_DELAY_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;

function readPackageVersion(metadata: unknown): string {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    metadata.version.trim().length === 0
  ) {
    throw new Error("@roll-agent/client-node package metadata is missing a valid version");
  }
  return metadata.version;
}

const DEFAULT_CLIENT_VERSION = readPackageVersion(clientNodePackage);

const JSON_RPC_ERROR_CODES = {
  methodNotFound: -32_601,
  invalidParams: -32_602,
  internalError: -32_603,
} as const;

const READ_ONLY_RUNTIME_METHODS = new Set<RuntimeMethod>([
  RUNTIME_METHODS.threadList,
  RUNTIME_METHODS.threadSnapshot,
  RUNTIME_METHODS.threadCapabilities,
  RUNTIME_METHODS.operationGet,
]);

export interface RuntimeClientTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  close(): void;
  terminate?(): void;
  forceClose?(): void;
}

export interface RuntimeShutdownOptions {
  readonly gracefulTimeoutMs?: number;
  readonly terminateTimeoutMs?: number;
  readonly forceKillTimeoutMs?: number;
}

interface NormalizedRuntimeShutdownOptions {
  readonly gracefulTimeoutMs: number;
  readonly terminateTimeoutMs: number;
  readonly forceKillTimeoutMs: number;
}

export interface RuntimeServerRequestContext {
  readonly requestId: JsonRpcId;
  readonly signal: AbortSignal;
}

export type RuntimeServerRequestHandlerParams<TMethod extends RuntimeServerRequestMethod> =
  RuntimeServerRequestParamsForSupportedVersions<TMethod>;

export type RuntimeServerRequestHandler<TMethod extends RuntimeServerRequestMethod> = (
  params: RuntimeServerRequestHandlerParams<TMethod>,
  context: RuntimeServerRequestContext,
) =>
  | RuntimeServerRequestResultForSupportedVersions<TMethod>
  | Promise<RuntimeServerRequestResultForSupportedVersions<TMethod>>;

export type RuntimeServerRequestHandlers = {
  readonly [TMethod in RuntimeServerRequestMethod]?: RuntimeServerRequestHandler<TMethod>;
};

export type UserInputRequestHandlerParams = RuntimeServerRequestHandlerParams<
  typeof RUNTIME_SERVER_REQUEST_METHODS.userInputRequest
>;
export type UserInputRequestHandler = RuntimeServerRequestHandler<
  typeof RUNTIME_SERVER_REQUEST_METHODS.userInputRequest
>;

export type RuntimeClientMethodResult<TMethod extends RuntimeMethod> =
  RuntimeMethodResultForVersion<RuntimeProtocolVersion, TMethod>;

type RuntimeClientMethodParams<TMethod extends RuntimeMethod> = RuntimeMethodParamsForVersion<
  RuntimeProtocolVersion,
  TMethod
>;

type MutableRuntimeServerRequestHandlers = {
  -readonly [TMethod in RuntimeServerRequestMethod]?: RuntimeServerRequestHandler<TMethod>;
};

type DynamicCapabilityRuntimeProtocolVersion = Extract<RuntimeProtocolVersion, "1.3" | "1.2">;

function usesDynamicServerRequestCapabilities(
  version: RuntimeProtocolVersion,
): version is DynamicCapabilityRuntimeProtocolVersion {
  return version === "1.3" || version === "1.2";
}

function setRuntimeServerRequestHandler<TMethod extends RuntimeServerRequestMethod>(
  handlers: MutableRuntimeServerRequestHandlers,
  method: TMethod,
  handler: RuntimeServerRequestHandler<TMethod>,
): void {
  Object.assign(handlers, { [method]: handler });
}

function resolveRuntimeServerRequestHandlers(options: {
  readonly serverRequestHandlers?: RuntimeServerRequestHandlers;
  readonly onUserInputRequest?: UserInputRequestHandler;
}): MutableRuntimeServerRequestHandlers {
  const handlers: MutableRuntimeServerRequestHandlers = { ...options.serverRequestHandlers };
  const genericUserInputHandler = handlers[RUNTIME_SERVER_REQUEST_METHODS.userInputRequest];
  if (
    genericUserInputHandler !== undefined &&
    options.onUserInputRequest !== undefined &&
    genericUserInputHandler !== options.onUserInputRequest
  ) {
    throw new Error(
      'Provide userInput.request through either "onUserInputRequest" or "serverRequestHandlers", not both',
    );
  }
  if (options.onUserInputRequest !== undefined) {
    handlers[RUNTIME_SERVER_REQUEST_METHODS.userInputRequest] = options.onUserInputRequest;
  }
  return handlers;
}

function supportsRuntimeProtocolVersion(
  version: RuntimeProtocolVersion,
  handlers: RuntimeServerRequestHandlers,
): boolean {
  return getRuntimeProtocolCapabilities(version).requiredServerRequestMethods.every(
    (method) => typeof handlers[method] === "function",
  );
}

function parseClientRuntimeServerRequestParams<TMethod extends RuntimeServerRequestMethod>(
  version: "1.3" | "1.2" | "1.1",
  method: TMethod,
  value: unknown,
): RuntimeServerRequestHandlerParams<TMethod> {
  if (usesDynamicServerRequestCapabilities(version)) {
    if (!isRuntimeServerRequestMethodAvailable(version, method)) {
      throw new Error(`Runtime Protocol ${version} does not support server request ${method}`);
    }
    return parseRuntimeServerRequestParamsForVersion(
      version,
      method,
      value,
    ) as RuntimeServerRequestHandlerParams<TMethod>;
  }
  if (!isRuntimeServerRequestMethodAvailable(version, method)) {
    throw new Error(`Runtime Protocol ${version} does not support server request ${method}`);
  }
  return parseRuntimeServerRequestParamsForVersion(
    version,
    method,
    value,
  ) as RuntimeServerRequestHandlerParams<TMethod>;
}

function parseClientRuntimeMethodParams<TMethod extends RuntimeMethod>(
  version: RuntimeProtocolVersion,
  method: TMethod,
  value: unknown,
): RuntimeClientMethodParams<TMethod> {
  return parseRuntimeMethodParamsForVersion(version, method, value);
}

function parseClientRuntimeMethodResult<TMethod extends RuntimeMethod>(
  version: RuntimeProtocolVersion,
  method: TMethod,
  value: unknown,
): RuntimeClientMethodResult<TMethod> {
  return parseRuntimeMethodResultForVersion(version, method, value);
}

function parseClientRuntimeServerRequestResult<TMethod extends RuntimeServerRequestMethod>(
  version: "1.3" | "1.2" | "1.1",
  method: TMethod,
  value: unknown,
): RuntimeServerRequestResultForSupportedVersions<TMethod> {
  if (usesDynamicServerRequestCapabilities(version)) {
    if (!isRuntimeServerRequestMethodAvailable(version, method)) {
      throw new Error(`Runtime Protocol ${version} does not support server request ${method}`);
    }
    return parseRuntimeServerRequestResultForVersion(
      version,
      method,
      value,
    ) as RuntimeServerRequestResultForSupportedVersions<TMethod>;
  }
  if (!isRuntimeServerRequestMethodAvailable(version, method)) {
    throw new Error(`Runtime Protocol ${version} does not support server request ${method}`);
  }
  return parseRuntimeServerRequestResultForVersion(
    version,
    method,
    value,
  ) as RuntimeServerRequestResultForSupportedVersions<TMethod>;
}

export interface RollNodeClientOptions {
  readonly cwd: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onStderr?: (line: string) => void;
  readonly onTurnOutcomeUnknown?: (turnId: TurnId) => void;
  readonly maxFrameBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly maxReadRetries?: number;
  readonly readRetryDelayMs?: number;
  readonly shutdownOptions?: RuntimeShutdownOptions;
  readonly serverRequestHandlers?: RuntimeServerRequestHandlers;
  readonly onUserInputRequest?: UserInputRequestHandler;
}

export interface ConnectRuntimeClientOptions {
  readonly transport: RuntimeClientTransport;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onStderr?: (line: string) => void;
  readonly onTurnOutcomeUnknown?: (turnId: TurnId) => void;
  readonly maxFrameBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly maxReadRetries?: number;
  readonly readRetryDelayMs?: number;
  readonly shutdownOptions?: RuntimeShutdownOptions;
  readonly serverRequestHandlers?: RuntimeServerRequestHandlers;
  readonly onUserInputRequest?: UserInputRequestHandler;
}

interface PendingRequest {
  readonly method: LatestRuntimeMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly acceptResult?: (value: unknown) => void;
}

interface InFlightServerRequest {
  readonly controller: AbortController;
  readonly method: RuntimeServerRequestMethod;
  readonly requestId: JsonRpcId;
  interactionId?: InteractionId;
}

type ClientRuntimeProtocolErrorData = RuntimeProtocolErrorDataForVersion<RuntimeProtocolVersion>;

export interface RuntimeClientExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error;
}

export class RollRpcError extends Error {
  readonly code: number;
  readonly data: ClientRuntimeProtocolErrorData | undefined;

  constructor(error: {
    readonly code: number;
    readonly message: string;
    readonly data?: ClientRuntimeProtocolErrorData;
  }) {
    super(error.message);
    this.name = "RollRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class RollRuntimeExitedError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    super(
      `Roll Runtime exited before the request completed (code=${String(code)}, signal=${String(signal)})`,
    );
    this.name = "RollRuntimeExitedError";
    this.code = code;
    this.signal = signal;
  }
}

export class RollRequestTimeoutError extends Error {
  readonly method: LatestRuntimeMethod;
  readonly timeoutMs: number;

  constructor(method: LatestRuntimeMethod, timeoutMs: number) {
    super(`Roll Runtime request "${method}" timed out after ${String(timeoutMs)} ms`);
    this.name = "RollRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class RollRequestFrameTooLargeError extends Error {
  readonly frameBytes: number;
  readonly maxFrameBytes: number;

  constructor(frameBytes: number, maxFrameBytes: number) {
    super(
      `Roll Runtime request frame is ${String(frameBytes)} bytes, exceeding the ${String(
        maxFrameBytes,
      )} byte limit`,
    );
    this.name = "RollRequestFrameTooLargeError";
    this.frameBytes = frameBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
}

export class RollRuntimeClosingError extends Error {
  constructor() {
    super("Roll Runtime client is shutting down");
    this.name = "RollRuntimeClosingError";
  }
}

export class RollRuntimeShutdownTimeoutError extends Error {
  readonly gracefulTimeoutMs: number;
  readonly terminateTimeoutMs: number;
  readonly forceKillTimeoutMs: number;

  constructor(gracefulTimeoutMs: number, terminateTimeoutMs: number, forceKillTimeoutMs: number) {
    super(
      `Roll Runtime did not exit within ${String(
        gracefulTimeoutMs + terminateTimeoutMs + forceKillTimeoutMs,
      )} ms`,
    );
    this.name = "RollRuntimeShutdownTimeoutError";
    this.gracefulTimeoutMs = gracefulTimeoutMs;
    this.terminateTimeoutMs = terminateTimeoutMs;
    this.forceKillTimeoutMs = forceKillTimeoutMs;
  }
}

export class RollProtocolViolationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RollProtocolViolationError";
  }
}

export class RollUncorrelatedRpcError extends RollRpcError {
  constructor(error: {
    readonly code: number;
    readonly message: string;
    readonly data?: ClientRuntimeProtocolErrorData;
  }) {
    super(error);
    this.name = "RollUncorrelatedRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInteractionId(value: unknown): InteractionId | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const parsed = interactionIdSchema.safeParse(value.interactionId);
  return parsed.success ? parsed.data : undefined;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeShutdownOptions(
  options: RuntimeShutdownOptions = {},
): NormalizedRuntimeShutdownOptions {
  return {
    gracefulTimeoutMs: positiveInteger(
      options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      "gracefulTimeoutMs",
    ),
    terminateTimeoutMs: positiveInteger(
      options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
      "terminateTimeoutMs",
    ),
    forceKillTimeoutMs: positiveInteger(
      options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS,
      "forceKillTimeoutMs",
    ),
  };
}

function parseRpcError(
  value: unknown,
  context: string,
  protocolVersion: RuntimeProtocolVersion | undefined,
): {
  readonly code: number;
  readonly message: string;
  readonly data?: ClientRuntimeProtocolErrorData;
} {
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    !Number.isInteger(value.code) ||
    typeof value.message !== "string"
  ) {
    throw new RollProtocolViolationError(`Roll Runtime returned an invalid error for ${context}`);
  }
  let errorData: ClientRuntimeProtocolErrorData | undefined;
  if (value.data !== undefined) {
    try {
      errorData = parseRuntimeProtocolErrorDataForVersion(protocolVersion ?? "1.1", value.data);
    } catch (error: unknown) {
      throw new RollProtocolViolationError(
        `Roll Runtime returned invalid error data for ${context}`,
        error,
      );
    }
  }
  return {
    code: value.code,
    message: value.message,
    ...(errorData === undefined ? {} : { data: errorData }),
  };
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function toChildTransport(child: ChildProcessWithoutNullStreams): RuntimeClientTransport {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit(listener) {
      let notified = false;
      const notify = (code: number | null, signal: NodeJS.Signals | null) => {
        if (notified) {
          return;
        }
        notified = true;
        listener(code, signal);
      };
      child.once("close", notify);
      child.once("error", () => notify(null, null));
    },
    close() {
      child.stdin.end();
    },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
    forceClose() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}

export class RollNodeClient {
  private readonly transport: RuntimeClientTransport;
  private readonly maxFrameBytes: number;
  private outboundMaxFrameBytes: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly listeners = new Set<(event: RuntimeEventEnvelope) => void>();
  private readonly exitListeners = new Set<(exit: RuntimeClientExit) => void>();
  private readonly activeTurns = new Set<TurnId>();
  private readonly unknownTurns = new Set<TurnId>();
  private readonly serverRequestHandlers: MutableRuntimeServerRequestHandlers;
  private readonly serverRequestHandlerCapabilityRevisions = new Map<
    RuntimeServerRequestMethod,
    number
  >();
  private readonly advertisedProtocolVersions: readonly RuntimeProtocolVersion[];
  private readonly inFlightServerRequests = new Map<JsonRpcId, InFlightServerRequest>();
  private readonly inFlightServerRequestsByInteractionId = new Map<
    InteractionId,
    InFlightServerRequest
  >();
  private acknowledgedServerRequestMethods = new Set<RuntimeServerRequestMethod>();
  private readonly onTurnOutcomeUnknown: ((turnId: TurnId) => void) | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly readRetryDelayMs: number;
  private readonly defaultShutdownOptions: NormalizedRuntimeShutdownOptions;
  private readonly outputReader: ReturnType<typeof createInterface>;
  private readonly stderrReader: ReturnType<typeof createInterface> | undefined;
  private requestId = 0;
  private capabilityRevision = 0;
  private acknowledgedCapabilityRevision = 0;
  private writeQueue = Promise.resolve();
  private capabilitySyncTail = Promise.resolve();
  private readonly exitPromise: Promise<RuntimeClientExit>;
  private resolveExit!: (exit: RuntimeClientExit) => void;
  private exited = false;
  private closing = false;
  private outputReaderClosed = false;
  private stderrReaderClosed = false;
  private initializationResult: InitializeResult | undefined;
  private connectionFailure: Error | undefined;
  private exitResult: RuntimeClientExit | undefined;
  private shutdownPromise: Promise<RuntimeClientExit> | undefined;
  private eventRecoveryManager: RuntimeEventRecoveryManager | undefined;

  private constructor(options: ConnectRuntimeClientOptions) {
    this.transport = options.transport;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.outboundMaxFrameBytes = this.maxFrameBytes;
    this.onTurnOutcomeUnknown = options.onTurnOutcomeUnknown;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxReadRetries = options.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES;
    this.readRetryDelayMs = options.readRetryDelayMs ?? DEFAULT_READ_RETRY_DELAY_MS;
    this.defaultShutdownOptions = normalizeShutdownOptions(options.shutdownOptions);
    this.serverRequestHandlers = resolveRuntimeServerRequestHandlers(options);
    this.advertisedProtocolVersions = SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.filter(
      (version) =>
        supportsRuntimeProtocolVersion(version, this.serverRequestHandlers) &&
        (version !== "1.3" || this.maxFrameBytes >= RUNTIME_V13_MIN_CLIENT_FRAME_BYTES),
    );
    if (!Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new Error("maxFrameBytes must be a positive integer");
    }
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.maxReadRetries) || this.maxReadRetries < 0) {
      throw new Error("maxReadRetries must be a non-negative integer");
    }
    if (!Number.isInteger(this.readRetryDelayMs) || this.readRetryDelayMs < 0) {
      throw new Error("readRetryDelayMs must be a non-negative integer");
    }
    this.exitPromise = new Promise<RuntimeClientExit>((resolve) => {
      this.resolveExit = resolve;
    });
    this.outputReader = createInterface({ input: options.transport.stdout });
    this.outputReader.on("line", (line) => this.handleLine(line));
    this.stderrReader =
      options.transport.stderr === undefined
        ? undefined
        : createInterface({ input: options.transport.stderr });
    this.stderrReader?.on("line", (line) => {
      try {
        options.onStderr?.(line);
      } catch {
        // Diagnostic observers must not interrupt transport lifecycle handling.
      }
    });
    this.transport.onExit((code, signal) => this.handleExit(code, signal));
  }

  static async start(options: RollNodeClientOptions): Promise<RollNodeClient> {
    if (options.cwd.trim().length === 0) {
      throw new Error("RollNodeClient requires an explicit non-empty cwd");
    }
    const child = spawn(
      options.command ?? "roll",
      [...(options.args ?? ["runtime", "serve", "--stdio"])],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: "pipe",
      },
    );
    const client = await RollNodeClient.connect({
      transport: toChildTransport(child),
      ...(options.clientName !== undefined ? { clientName: options.clientName } : {}),
      ...(options.clientVersion !== undefined ? { clientVersion: options.clientVersion } : {}),
      ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
      ...(options.onTurnOutcomeUnknown !== undefined
        ? { onTurnOutcomeUnknown: options.onTurnOutcomeUnknown }
        : {}),
      ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.maxReadRetries !== undefined ? { maxReadRetries: options.maxReadRetries } : {}),
      ...(options.readRetryDelayMs !== undefined
        ? { readRetryDelayMs: options.readRetryDelayMs }
        : {}),
      ...(options.shutdownOptions !== undefined
        ? { shutdownOptions: options.shutdownOptions }
        : {}),
      ...(options.serverRequestHandlers !== undefined
        ? { serverRequestHandlers: options.serverRequestHandlers }
        : {}),
      ...(options.onUserInputRequest !== undefined
        ? { onUserInputRequest: options.onUserInputRequest }
        : {}),
    });
    return client;
  }

  static async connect(options: ConnectRuntimeClientOptions): Promise<RollNodeClient> {
    let client: RollNodeClient | undefined;
    try {
      client = new RollNodeClient(options);
      client.initializationResult = await client.request(RUNTIME_METHODS.initialize, {
        protocolVersions: [...client.advertisedProtocolVersions],
        client: {
          name: options.clientName ?? "@roll-agent/client-node",
          version: options.clientVersion ?? DEFAULT_CLIENT_VERSION,
        },
      });
      client.acceptInitializationResult(client.initializationResult);
      await client.initializeServerRequestCapabilities();
      return client;
    } catch (error: unknown) {
      if (client === undefined) {
        options.transport.close();
      } else {
        await client.shutdown().catch(() => {});
      }
      throw error;
    }
  }

  private async initializeServerRequestCapabilities(): Promise<void> {
    const protocolVersion = this.getInitializationResult().protocolVersion;
    if (usesDynamicServerRequestCapabilities(protocolVersion)) {
      await this.queueServerRequestCapabilitySync();
      return;
    }
    this.acknowledgedServerRequestMethods = new Set(
      getRuntimeProtocolRegistry(protocolVersion).serverRequestMethods.filter(
        (method) => this.serverRequestHandlers[method] !== undefined,
      ),
    );
  }

  private queueServerRequestCapabilitySync(): Promise<void> {
    const protocolVersion = this.getInitializationResult().protocolVersion;
    if (!usesDynamicServerRequestCapabilities(protocolVersion)) {
      return Promise.resolve();
    }
    if (this.capabilityRevision >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(
        new RollProtocolViolationError("Runtime Client capability revision was exhausted"),
      );
    }
    const revision = this.capabilityRevision + 1;
    this.capabilityRevision = revision;
    const serverRequestMethods = getRuntimeProtocolRegistry(
      protocolVersion,
    ).serverRequestMethods.filter((method) => this.serverRequestHandlers[method] !== undefined);
    for (const method of serverRequestMethods) {
      if (!this.serverRequestHandlerCapabilityRevisions.has(method)) {
        this.serverRequestHandlerCapabilityRevisions.set(method, revision);
      }
    }
    const sync = this.capabilitySyncTail.then(async () => {
      await this.requestClientCapabilitiesSet(protocolVersion, revision, serverRequestMethods);
    });
    this.capabilitySyncTail = sync;
    return sync;
  }

  private requestClientCapabilitiesSet(
    protocolVersion: DynamicCapabilityRuntimeProtocolVersion,
    revision: number,
    serverRequestMethods: readonly RuntimeServerRequestMethod[],
  ): Promise<ClientCapabilitiesSetResult> {
    if (this.connectionFailure !== undefined) {
      return Promise.reject(this.connectionFailure);
    }
    if (this.exited) {
      return Promise.reject(this.exitResult?.error ?? new RollRuntimeExitedError(null, null));
    }
    if (this.closing) {
      return Promise.reject(new RollRuntimeClosingError());
    }
    const method = RUNTIME_METHODS.clientCapabilitiesSet;
    const params = parseRuntimeMethodParamsForVersion(protocolVersion, method, {
      revision,
      serverRequestMethods: [...serverRequestMethods],
    });
    return this.requestOnce(
      method,
      params,
      (value) => parseRuntimeMethodResultForVersion(protocolVersion, method, value),
      (value) => {
        this.acceptClientCapabilitiesSetResult(
          protocolVersion,
          revision,
          serverRequestMethods,
          value,
        );
      },
    );
  }

  private acceptClientCapabilitiesSetResult(
    protocolVersion: DynamicCapabilityRuntimeProtocolVersion,
    revision: number,
    serverRequestMethods: readonly RuntimeServerRequestMethod[],
    value: unknown,
  ): void {
    const result = parseRuntimeMethodResultForVersion(
      protocolVersion,
      RUNTIME_METHODS.clientCapabilitiesSet,
      value,
    );
    if (result.revision !== revision) {
      throw new RollProtocolViolationError(
        `Roll Runtime acknowledged Client capability revision ${String(
          result.revision,
        )}; expected ${String(revision)}`,
      );
    }
    const requested = new Set(serverRequestMethods);
    const accepted = new Set(result.acceptedServerRequestMethods);
    for (const method of accepted) {
      if (!requested.has(method)) {
        throw new RollProtocolViolationError(
          `Roll Runtime acknowledged Client capability method "${method}" that was not requested`,
        );
      }
    }
    this.acknowledgedCapabilityRevision = revision;
    this.acknowledgedServerRequestMethods = accepted;
  }

  private observeServerRequestCapabilitySync(sync: Promise<void>): void {
    sync.catch((error: unknown) => {
      this.failConnection(error instanceof Error ? error : new Error(String(error)));
    });
  }

  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Creates the single per-connection manager for durable Runtime Event recovery. */
  createEventRecovery(
    options: RuntimeEventRecoveryManagerOptions = {},
  ): RuntimeEventRecoveryManager {
    if (this.connectionFailure !== undefined) {
      throw this.connectionFailure;
    }
    if (this.exited) {
      throw this.exitResult?.error ?? new RollRuntimeExitedError(null, null);
    }
    if (this.closing) {
      throw new RollRuntimeClosingError();
    }
    if (this.eventRecoveryManager !== undefined && !this.eventRecoveryManager.isClosed()) {
      return this.eventRecoveryManager;
    }
    this.eventRecoveryManager = new RuntimeEventRecoveryManager(
      {
        getInitializationResult: () => this.getInitializationResult(),
        requestSnapshot: (threadId) => this.requestEventRecoverySnapshot(threadId),
        requestResume: (input, acceptResult) =>
          this.requestRuntimeEventsResume(input, acceptResult),
      },
      options,
    );
    return this.eventRecoveryManager;
  }

  onExit(listener: (exit: RuntimeClientExit) => void): () => void {
    const exitResult = this.exitResult;
    if (exitResult !== undefined) {
      queueMicrotask(() => {
        try {
          listener(exitResult);
        } catch {
          // Exit observers are isolated from the already-settled client lifecycle.
        }
      });
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  getInitializationResult(): InitializeResult {
    if (this.initializationResult === undefined) {
      throw new Error("Roll Runtime client has not completed initialization");
    }
    return this.initializationResult;
  }

  registerServerRequestHandler<TMethod extends RuntimeServerRequestMethod>(
    method: TMethod,
    handler: RuntimeServerRequestHandler<TMethod>,
  ): () => void {
    if (this.connectionFailure !== undefined) {
      throw this.connectionFailure;
    }
    if (this.exited) {
      throw this.exitResult?.error ?? new RollRuntimeExitedError(null, null);
    }
    if (this.closing) {
      throw new RollRuntimeClosingError();
    }
    if (!isLatestRuntimeServerRequestMethod(method)) {
      throw new Error(`Unknown Runtime server request method: ${String(method)}`);
    }
    const protocolVersion = this.initializationResult?.protocolVersion;
    if (
      protocolVersion !== undefined &&
      !getRuntimeProtocolCapabilities(protocolVersion).serverRequests
    ) {
      throw new Error(
        `Cannot register a Runtime server request handler after Protocol ${protocolVersion} ` +
          "was negotiated; " +
          "pass serverRequestHandlers to RollNodeClient.connect() or RollNodeClient.start()",
      );
    }
    const previousHandler = this.serverRequestHandlers[method];
    setRuntimeServerRequestHandler(this.serverRequestHandlers, method, handler);
    if (
      protocolVersion !== undefined &&
      usesDynamicServerRequestCapabilities(protocolVersion) &&
      previousHandler === undefined
    ) {
      this.observeServerRequestCapabilitySync(this.queueServerRequestCapabilitySync());
    }
    return () => {
      if (this.serverRequestHandlers[method] !== handler) {
        return;
      }
      const negotiatedVersion = this.initializationResult?.protocolVersion;
      if (
        negotiatedVersion !== undefined &&
        isRuntimeServerRequestMethodRequired(negotiatedVersion, method)
      ) {
        this.failProtocol(
          new RollProtocolViolationError(
            `Cannot unregister required Runtime server request handler "${method}" ` +
              `while Protocol ${negotiatedVersion} is active`,
          ),
        );
        return;
      }
      delete this.serverRequestHandlers[method];
      this.serverRequestHandlerCapabilityRevisions.delete(method);
      if (
        negotiatedVersion !== undefined &&
        usesDynamicServerRequestCapabilities(negotiatedVersion)
      ) {
        this.retireServerRequestsForMethod(
          method,
          new Error(`Runtime Client capability "${method}" was withdrawn`),
        );
        this.observeServerRequestCapabilitySync(this.queueServerRequestCapabilitySync());
      }
    };
  }

  /** Registers the typed Runtime Protocol 1.3/1.2 userInput.request handler. */
  onUserInputRequest(handler: UserInputRequestHandler): () => void {
    return this.registerServerRequestHandler(
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      handler,
    );
  }

  private requestEventRecoverySnapshot(threadId: ThreadId): Promise<RuntimeEventRecoverySnapshot> {
    if (this.connectionFailure !== undefined) {
      return Promise.reject(this.connectionFailure);
    }
    if (this.exited) {
      return Promise.reject(this.exitResult?.error ?? new RollRuntimeExitedError(null, null));
    }
    if (this.closing) {
      return Promise.reject(new RollRuntimeClosingError());
    }
    const protocolVersion = this.getInitializationResult().protocolVersion;
    if (protocolVersion !== "1.3") {
      return this.request(RUNTIME_METHODS.threadSnapshot, { threadId, limit: 1 });
    }
    const method = RUNTIME_METHODS.threadSnapshot;
    const params = parseRuntimeMethodParamsForVersion(protocolVersion, method, {
      threadId,
      limit: 1,
      recovery: true,
    });
    return this.requestOnce(method, params, (value) =>
      parseRuntimeMethodResultForVersion(protocolVersion, method, value),
    );
  }

  private requestRuntimeEventsResume(
    input: RuntimeMethodInputForVersion<"1.3", typeof RUNTIME_METHODS.runtimeEventsResume>,
    acceptResult: (
      result: RuntimeMethodResultForVersion<"1.3", typeof RUNTIME_METHODS.runtimeEventsResume>,
    ) => void,
  ): Promise<RuntimeMethodResultForVersion<"1.3", typeof RUNTIME_METHODS.runtimeEventsResume>> {
    if (this.connectionFailure !== undefined) {
      return Promise.reject(this.connectionFailure);
    }
    if (this.exited) {
      return Promise.reject(this.exitResult?.error ?? new RollRuntimeExitedError(null, null));
    }
    if (this.closing) {
      return Promise.reject(new RollRuntimeClosingError());
    }
    if (this.getInitializationResult().protocolVersion !== "1.3") {
      return Promise.reject(
        new RuntimeEventRecoveryError(
          "runtime.events.resume requires negotiated Runtime Protocol 1.3",
        ),
      );
    }
    const method = RUNTIME_METHODS.runtimeEventsResume;
    const params = parseRuntimeMethodParamsForVersion("1.3", method, input);
    return this.requestOnce(
      method,
      params,
      (value) => parseRuntimeMethodResultForVersion("1.3", method, value),
      (value) => {
        acceptResult(parseRuntimeMethodResultForVersion("1.3", method, value));
      },
    );
  }

  async request<TMethod extends RuntimeMethod>(
    method: TMethod,
    input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeClientMethodResult<TMethod>> {
    if (this.connectionFailure !== undefined) {
      throw this.connectionFailure;
    }
    if (this.exited) {
      throw this.exitResult?.error ?? new RollRuntimeExitedError(null, null);
    }
    if (this.closing) {
      throw new RollRuntimeClosingError();
    }
    if (method === RUNTIME_METHODS.initialize && this.initializationResult !== undefined) {
      throw new Error("Roll Runtime client has already completed initialization");
    }
    const protocolVersion = this.initializationResult?.protocolVersion;
    const params =
      protocolVersion === undefined
        ? parseRuntimeMethodParams(method, input)
        : parseClientRuntimeMethodParams(protocolVersion, method, input);
    const startingTurn =
      method === RUNTIME_METHODS.turnStart
        ? parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, params).turnId
        : undefined;
    if (startingTurn !== undefined) {
      this.activeTurns.add(startingTurn);
    }
    let readRetries = 0;
    while (true) {
      try {
        return await this.requestOnce(method, params, (value) =>
          protocolVersion === undefined
            ? method === RUNTIME_METHODS.initialize
              ? (initializeResultSchema.parse(value) as RuntimeClientMethodResult<TMethod>)
              : parseRuntimeMethodResult(method, value)
            : parseClientRuntimeMethodResult(protocolVersion, method, value),
        );
      } catch (error: unknown) {
        if (
          !READ_ONLY_RUNTIME_METHODS.has(method) ||
          !(error instanceof RollRpcError) ||
          error.data?.retryable !== true ||
          readRetries >= this.maxReadRetries
        ) {
          if (startingTurn !== undefined) {
            if (
              (error instanceof RollRpcError && !(error instanceof RollUncorrelatedRpcError)) ||
              error instanceof RollRequestFrameTooLargeError
            ) {
              this.activeTurns.delete(startingTurn);
            } else {
              this.markTurnOutcomeUnknown(startingTurn);
            }
          }
          throw error;
        }
        readRetries += 1;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.readRetryDelayMs);
        });
      }
    }
  }

  private async requestOnce<TMethod extends LatestRuntimeMethod, TResult>(
    method: TMethod,
    params: unknown,
    parseResult: (value: unknown) => TResult,
    acceptResult?: (value: unknown) => void,
  ): Promise<TResult> {
    const id = this.requestId;
    this.requestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new RollRequestTimeoutError(method, this.requestTimeoutMs));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        ...(acceptResult === undefined ? {} : { acceptResult }),
      });
    });
    try {
      await this.write({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
      const result = await response;
      try {
        return parseResult(result);
      } catch (error: unknown) {
        const violation = new RollProtocolViolationError(
          `Roll Runtime returned an invalid result for "${method}"`,
          error,
        );
        this.failProtocol(violation);
        throw violation;
      }
    } catch (error: unknown) {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }
  }

  getOutcomeUnknownTurnIds(): readonly TurnId[] {
    return [...this.unknownTurns];
  }

  close(): void {
    this.shutdown().catch(() => {});
  }

  shutdown(options?: RuntimeShutdownOptions): Promise<RuntimeClientExit> {
    const exitResult = this.exitResult;
    if (exitResult !== undefined) {
      return Promise.resolve(exitResult);
    }
    this.shutdownPromise ??= this.performShutdown(
      options === undefined ? this.defaultShutdownOptions : normalizeShutdownOptions(options),
    );
    return this.shutdownPromise;
  }

  private async performShutdown(
    options: NormalizedRuntimeShutdownOptions,
  ): Promise<RuntimeClientExit> {
    const { gracefulTimeoutMs, terminateTimeoutMs, forceKillTimeoutMs } = options;
    this.closing = true;
    this.abortServerRequests(new RollRuntimeClosingError());
    this.transport.close();
    const gracefulExit = await waitWithTimeout(this.exitPromise, gracefulTimeoutMs);
    if (gracefulExit !== undefined) {
      return gracefulExit;
    }
    if (this.transport.terminate !== undefined) {
      this.transport.terminate();
      const terminatedExit = await waitWithTimeout(this.exitPromise, terminateTimeoutMs);
      if (terminatedExit !== undefined) {
        return terminatedExit;
      }
    }
    if (this.transport.forceClose === undefined) {
      const error = new RollRuntimeShutdownTimeoutError(
        gracefulTimeoutMs,
        terminateTimeoutMs,
        forceKillTimeoutMs,
      );
      this.finishExit(error, null, null);
      this.closeReaders();
      throw error;
    }
    this.transport.forceClose();
    const forcedExit = await waitWithTimeout(this.exitPromise, forceKillTimeoutMs);
    if (forcedExit !== undefined) {
      return forcedExit;
    }
    const error = new RollRuntimeShutdownTimeoutError(
      gracefulTimeoutMs,
      terminateTimeoutMs,
      forceKillTimeoutMs,
    );
    this.finishExit(error, null, null);
    this.closeReaders();
    throw error;
  }

  private async write(message: JsonRpcMessage, shouldWrite?: () => boolean): Promise<void> {
    const payload = JSON.stringify(message);
    const frameBytes = Buffer.byteLength(payload, "utf8");
    if (frameBytes > this.outboundMaxFrameBytes) {
      throw new RollRequestFrameTooLargeError(frameBytes, this.outboundMaxFrameBytes);
    }
    const frame = `${payload}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      if (
        this.closing ||
        this.connectionFailure !== undefined ||
        this.exited ||
        shouldWrite?.() === false
      ) {
        return;
      }
      if (!this.transport.stdin.write(frame)) {
        await once(this.transport.stdin, "drain");
      }
    });
    try {
      await this.writeQueue;
    } catch (error: unknown) {
      const violation = new RollProtocolViolationError(
        "Failed to write to the Roll Runtime transport",
        error,
      );
      this.failProtocol(violation);
      throw violation;
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
      this.failProtocol(
        new RollProtocolViolationError(
          `Roll Runtime frame exceeds ${String(this.maxFrameBytes)} bytes`,
        ),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error: unknown) {
      this.failProtocol(new RollProtocolViolationError("Roll Runtime emitted invalid JSON", error));
      return;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
      this.failProtocol(
        new RollProtocolViolationError("Roll Runtime emitted an invalid JSON-RPC frame"),
      );
      return;
    }
    const hasMethod = Object.hasOwn(parsed, "method");
    const hasId = Object.hasOwn(parsed, "id");
    const hasResult = Object.hasOwn(parsed, "result");
    const hasError = Object.hasOwn(parsed, "error");
    if (hasMethod) {
      if (typeof parsed.method !== "string" || hasResult || hasError) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime emitted an invalid JSON-RPC request or notification",
          ),
        );
        return;
      }
      if (hasId) {
        if (!isJsonRpcId(parsed.id)) {
          this.failProtocol(
            new RollProtocolViolationError("Roll Runtime request has an invalid id"),
          );
          return;
        }
        this.handleServerRequest(parsed.id, parsed.method, parsed.params);
        return;
      }
      this.handleNotification(parsed.method, parsed.params);
      return;
    }
    if (!hasId) {
      this.failProtocol(new RollProtocolViolationError("Roll Runtime response is missing an id"));
      return;
    }
    if (parsed.id === null) {
      if (!hasError || hasResult) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime response with a null id must contain exactly one error",
          ),
        );
        return;
      }
      try {
        this.failConnection(
          new RollUncorrelatedRpcError(
            parseRpcError(
              parsed.error,
              "an uncorrelated request",
              this.initializationResult?.protocolVersion,
            ),
          ),
        );
      } catch (error: unknown) {
        this.failProtocol(
          error instanceof RollProtocolViolationError
            ? error
            : new RollProtocolViolationError(
                "Roll Runtime returned an invalid uncorrelated error",
                error,
              ),
        );
      }
      return;
    }
    if (!isJsonRpcId(parsed.id)) {
      this.failProtocol(new RollProtocolViolationError("Roll Runtime response has an invalid id"));
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (pending === undefined) {
      return;
    }
    if (hasError === hasResult) {
      this.failProtocol(
        new RollProtocolViolationError(
          `Roll Runtime response for "${pending.method}" must contain exactly one result or error`,
        ),
      );
      return;
    }
    if (hasError) {
      let rpcError: RollRpcError;
      try {
        rpcError = new RollRpcError(
          parseRpcError(
            parsed.error,
            `"${pending.method}"`,
            this.initializationResult?.protocolVersion,
          ),
        );
      } catch (error: unknown) {
        this.failProtocol(
          error instanceof RollProtocolViolationError
            ? error
            : new RollProtocolViolationError(
                `Roll Runtime returned an invalid error for "${pending.method}"`,
                error,
              ),
        );
        return;
      }
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      pending.reject(rpcError);
      return;
    }
    if (pending.method === RUNTIME_METHODS.initialize) {
      try {
        this.acceptInitializationResult(initializeResultSchema.parse(parsed.result));
      } catch (error: unknown) {
        this.failProtocol(
          error instanceof RollProtocolViolationError
            ? error
            : new RollProtocolViolationError(
                'Roll Runtime returned an invalid result for "initialize"',
                error,
              ),
        );
        return;
      }
    }
    if (pending.acceptResult !== undefined) {
      try {
        pending.acceptResult(parsed.result);
      } catch (error: unknown) {
        this.failProtocol(
          error instanceof RollProtocolViolationError
            ? error
            : new RollProtocolViolationError(
                `Roll Runtime returned an invalid result for "${pending.method}"`,
                error,
              ),
        );
        return;
      }
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    pending.resolve(parsed.result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === RUNTIME_EVENT_NOTIFICATION) {
      const event = runtimeEventEnvelopeSchema.safeParse(params);
      if (!event.success) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime emitted an invalid runtime.event",
            event.error,
          ),
        );
        return;
      }
      if (
        this.initializationResult === undefined ||
        event.data.protocolVersion !== this.initializationResult.protocolVersion
      ) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime emitted runtime.event outside the negotiated Protocol",
          ),
        );
        return;
      }
      this.handleEvent(event.data);
      return;
    }
    if (method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION) {
      const protocolVersion = this.initializationResult?.protocolVersion;
      if (
        protocolVersion === undefined ||
        !getRuntimeProtocolCapabilities(protocolVersion).serverRequests
      ) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime emitted runtime.serverRequest.cancel outside a negotiated " +
              "server-request capability",
          ),
        );
        return;
      }
      try {
        if (usesDynamicServerRequestCapabilities(protocolVersion)) {
          const cancellation = parseRuntimeServerRequestCancelParamsForVersion(
            protocolVersion,
            params,
          );
          const inFlight = this.inFlightServerRequestsByInteractionId.get(
            cancellation.interactionId,
          );
          if (inFlight !== undefined) {
            this.retireServerRequest(inFlight, new Error(cancellation.reason));
          }
          return;
        }
        if (protocolVersion === "1.1") {
          const cancellation = parseRuntimeServerRequestCancelParamsForVersion(
            protocolVersion,
            params,
          );
          const inFlight = this.inFlightServerRequests.get(cancellation.serverRequestId);
          if (inFlight !== undefined) {
            this.retireServerRequest(inFlight, new Error(cancellation.reason));
          }
          return;
        }
      } catch (error: unknown) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime emitted an invalid runtime.serverRequest.cancel",
            error,
          ),
        );
        return;
      }
      this.failProtocol(
        new RollProtocolViolationError(
          `Roll Runtime emitted runtime.serverRequest.cancel for unsupported Protocol ${protocolVersion}`,
        ),
      );
      return;
    }
    this.failProtocol(
      new RollProtocolViolationError(`Roll Runtime emitted an unknown notification: ${method}`),
    );
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (this.closing || this.connectionFailure !== undefined || this.exited) {
      return;
    }
    if (this.inFlightServerRequests.has(id)) {
      this.failProtocol(
        new RollProtocolViolationError(
          `Roll Runtime reused in-flight server request id ${JSON.stringify(id)}`,
        ),
      );
      return;
    }
    const protocolVersion = this.initializationResult?.protocolVersion;
    if (
      protocolVersion === undefined ||
      protocolVersion === "1.0" ||
      !getRuntimeProtocolCapabilities(protocolVersion).serverRequests ||
      !isLatestRuntimeServerRequestMethod(method) ||
      !isRuntimeServerRequestMethodAvailable(protocolVersion, method)
    ) {
      this.observeServerRequestResponse(
        this.writeServerRequestError(id, JSON_RPC_ERROR_CODES.methodNotFound, "Method not found"),
      );
      return;
    }
    const handler = this.serverRequestHandlers[method];
    const requiredCapabilityRevision = this.serverRequestHandlerCapabilityRevisions.get(method);
    if (
      (usesDynamicServerRequestCapabilities(protocolVersion) &&
        (!this.acknowledgedServerRequestMethods.has(method) ||
          requiredCapabilityRevision === undefined ||
          this.acknowledgedCapabilityRevision < requiredCapabilityRevision)) ||
      handler === undefined
    ) {
      this.observeServerRequestResponse(
        this.writeServerRequestError(id, JSON_RPC_ERROR_CODES.methodNotFound, "Method not found"),
      );
      return;
    }
    this.observeServerRequestResponse(
      this.dispatchServerRequest(protocolVersion, id, method, params, handler),
    );
  }

  private observeServerRequestResponse(response: Promise<void>): void {
    response.catch((error: unknown) => {
      if (this.connectionFailure === undefined && !this.exited) {
        this.failProtocol(
          new RollProtocolViolationError("Failed to respond to Runtime server request", error),
        );
      }
    });
  }

  private async dispatchServerRequest<TMethod extends RuntimeServerRequestMethod>(
    protocolVersion: "1.3" | "1.2" | "1.1",
    id: JsonRpcId,
    method: TMethod,
    input: unknown,
    handler: RuntimeServerRequestHandler<TMethod>,
  ): Promise<void> {
    const inFlight: InFlightServerRequest = {
      controller: new AbortController(),
      method,
      requestId: id,
    };
    this.inFlightServerRequests.set(id, inFlight);
    try {
      let params: RuntimeServerRequestHandlerParams<TMethod>;
      try {
        params = parseClientRuntimeServerRequestParams(protocolVersion, method, input);
      } catch {
        await this.writeServerRequestError(
          id,
          JSON_RPC_ERROR_CODES.invalidParams,
          "Invalid params",
          () => this.isServerRequestActive(id, inFlight),
        );
        return;
      }
      const interactionId = readInteractionId(params);
      if (
        interactionId !== undefined &&
        this.inFlightServerRequestsByInteractionId.has(interactionId)
      ) {
        this.failProtocol(
          new RollProtocolViolationError(
            `Roll Runtime reused in-flight interaction id ${JSON.stringify(interactionId)}`,
          ),
        );
        return;
      }
      if (interactionId !== undefined) {
        inFlight.interactionId = interactionId;
        this.inFlightServerRequestsByInteractionId.set(interactionId, inFlight);
        inFlight.controller.signal.addEventListener(
          "abort",
          () => {
            if (this.inFlightServerRequestsByInteractionId.get(interactionId) === inFlight) {
              this.inFlightServerRequestsByInteractionId.delete(interactionId);
            }
          },
          { once: true },
        );
      }
      let rawResult: RuntimeServerRequestResultForSupportedVersions<TMethod>;
      try {
        rawResult = await handler(params, {
          requestId: id,
          signal: inFlight.controller.signal,
        });
      } catch {
        if (this.isServerRequestActive(id, inFlight)) {
          await this.writeServerRequestError(
            id,
            JSON_RPC_ERROR_CODES.internalError,
            "Internal error",
            () => this.isServerRequestActive(id, inFlight),
          );
        }
        return;
      }
      if (!this.isServerRequestActive(id, inFlight)) {
        return;
      }
      let result: RuntimeServerRequestResultForSupportedVersions<TMethod>;
      try {
        result = parseClientRuntimeServerRequestResult(protocolVersion, method, rawResult);
      } catch {
        await this.writeServerRequestError(
          id,
          JSON_RPC_ERROR_CODES.internalError,
          "Internal error",
          () => this.isServerRequestActive(id, inFlight),
        );
        return;
      }
      if (this.isServerRequestActive(id, inFlight)) {
        await this.write({ jsonrpc: "2.0", id, result }, () =>
          this.isServerRequestActive(id, inFlight),
        );
      }
    } finally {
      this.retireServerRequest(inFlight);
    }
  }

  private retireServerRequest(request: InFlightServerRequest, reason?: Error): void {
    if (this.inFlightServerRequests.get(request.requestId) === request) {
      this.inFlightServerRequests.delete(request.requestId);
    }
    if (
      request.interactionId !== undefined &&
      this.inFlightServerRequestsByInteractionId.get(request.interactionId) === request
    ) {
      this.inFlightServerRequestsByInteractionId.delete(request.interactionId);
    }
    if (reason !== undefined && !request.controller.signal.aborted) {
      request.controller.abort(reason);
    }
  }

  private retireServerRequestsForMethod(method: RuntimeServerRequestMethod, reason: Error): void {
    for (const request of [...this.inFlightServerRequests.values()]) {
      if (request.method === method) {
        this.retireServerRequest(request, reason);
      }
    }
  }

  private isServerRequestActive(id: JsonRpcId, request: InFlightServerRequest): boolean {
    return !request.controller.signal.aborted && this.inFlightServerRequests.get(id) === request;
  }

  private async writeServerRequestError(
    id: JsonRpcId,
    code: (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES],
    message: string,
    shouldWrite?: () => boolean,
  ): Promise<void> {
    await this.write(
      {
        jsonrpc: "2.0",
        id,
        error: { code, message },
      },
      shouldWrite,
    );
  }

  private acceptInitializationResult(result: InitializeResult): void {
    if (!this.advertisedProtocolVersions.includes(result.protocolVersion)) {
      throw new RollProtocolViolationError(
        `Roll Runtime selected unadvertised Protocol ${result.protocolVersion}`,
      );
    }
    this.initializationResult = result;
    this.outboundMaxFrameBytes = Math.min(this.maxFrameBytes, result.limits.maxFrameBytes);
  }

  private handleEvent(event: RuntimeEventEnvelope): void {
    if (
      event.turnId !== undefined &&
      (event.event.type === "turn.completed" ||
        event.event.type === "turn.cancelled" ||
        event.event.type === "turn.failed")
    ) {
      this.activeTurns.delete(event.turnId);
    }
    if (this.eventRecoveryManager?.acceptEvent(event) === true) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Client event observers must not interrupt protocol processing or later subscribers.
      }
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = this.connectionFailure ?? new RollRuntimeExitedError(code, signal);
    this.abortServerRequests(error);
    this.finishExit(error, code, signal);
    this.closeReaders();
  }

  private abortServerRequests(reason: Error): void {
    const inFlight = [...this.inFlightServerRequests.values()];
    this.inFlightServerRequests.clear();
    for (const request of inFlight) {
      request.controller.abort(reason);
    }
  }

  private failProtocol(error: RollProtocolViolationError): void {
    this.failConnection(error);
  }

  private failConnection(error: Error): void {
    if (this.connectionFailure !== undefined || this.exited) {
      return;
    }
    this.connectionFailure = error;
    this.closing = true;
    this.rejectPending(error);
    this.markActiveTurnsOutcomeUnknown();
    this.closeOutputReader();
    this.shutdown().catch(() => undefined);
  }

  private closeOutputReader(): void {
    if (this.outputReaderClosed) {
      return;
    }
    this.outputReaderClosed = true;
    this.outputReader.close();
  }

  private closeReaders(): void {
    this.closeOutputReader();
    if (this.stderrReader === undefined || this.stderrReaderClosed) {
      return;
    }
    this.stderrReaderClosed = true;
    this.stderrReader.close();
  }

  private finishExit(error: Error, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.closing = true;
    this.rejectPending(error);
    this.markActiveTurnsOutcomeUnknown();
    this.exitResult = { code, signal, error };
    this.eventRecoveryManager?.acceptClientExit(error);
    this.resolveExit(this.exitResult);
    for (const listener of this.exitListeners) {
      try {
        listener(this.exitResult);
      } catch {
        // One exit observer must not block later observers or reader cleanup.
      }
    }
    this.exitListeners.clear();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private markActiveTurnsOutcomeUnknown(): void {
    for (const turnId of this.activeTurns) {
      this.markTurnOutcomeUnknown(turnId);
    }
    this.activeTurns.clear();
  }

  private markTurnOutcomeUnknown(turnId: TurnId): void {
    this.activeTurns.delete(turnId);
    if (this.unknownTurns.has(turnId)) {
      return;
    }
    this.unknownTurns.add(turnId);
    try {
      this.onTurnOutcomeUnknown?.(turnId);
    } catch {
      // Outcome diagnostics are observers; the unknown marker remains authoritative.
    }
  }
}
