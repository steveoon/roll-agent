import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import clientNodePackage from "../package.json" with { type: "json" };
import {
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  getRuntimeProtocolCapabilities,
  isRuntimeServerRequestMethod,
  isRuntimeServerRequestMethodRequired,
  parseRuntimeMethodParams,
  parseRuntimeMethodResult,
  parseRuntimeServerRequestParams,
  parseRuntimeServerRequestResult,
  runtimeEventEnvelopeSchema,
  runtimeProtocolErrorDataSchema,
  runtimeServerRequestCancelParamsSchema,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodInput,
  type RuntimeMethodParams,
  type RuntimeMethodResult,
  type RuntimeProtocolErrorData,
  type RuntimeProtocolVersion,
  type RuntimeServerRequestMethod,
  type RuntimeServerRequestParams,
  type RuntimeServerRequestResult,
  type TurnId,
} from "@roll-agent/protocol";

const DEFAULT_MAX_FRAME_BYTES = 4 * 1_024 * 1_024;
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

export type RuntimeServerRequestHandler<TMethod extends RuntimeServerRequestMethod> = (
  params: RuntimeServerRequestParams<TMethod>,
  context: RuntimeServerRequestContext,
) => RuntimeServerRequestResult<TMethod> | Promise<RuntimeServerRequestResult<TMethod>>;

export type RuntimeServerRequestHandlers = {
  readonly [TMethod in RuntimeServerRequestMethod]?: RuntimeServerRequestHandler<TMethod>;
};

type MutableRuntimeServerRequestHandlers = {
  -readonly [TMethod in RuntimeServerRequestMethod]?: RuntimeServerRequestHandler<TMethod>;
};

function supportsRuntimeProtocolVersion(
  version: RuntimeProtocolVersion,
  handlers: RuntimeServerRequestHandlers,
): boolean {
  return getRuntimeProtocolCapabilities(version).requiredServerRequestMethods.every(
    (method) => typeof handlers[method] === "function",
  );
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
}

interface PendingRequest {
  readonly method: RuntimeMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface InFlightServerRequest {
  readonly controller: AbortController;
}

export interface RuntimeClientExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error;
}

export class RollRpcError extends Error {
  readonly code: number;
  readonly data: RuntimeProtocolErrorData | undefined;

  constructor(error: {
    readonly code: number;
    readonly message: string;
    readonly data?: RuntimeProtocolErrorData;
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
  readonly method: RuntimeMethod;
  readonly timeoutMs: number;

  constructor(method: RuntimeMethod, timeoutMs: number) {
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
    readonly data?: RuntimeProtocolErrorData;
  }) {
    super(error);
    this.name = "RollUncorrelatedRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): {
  readonly code: number;
  readonly message: string;
  readonly data?: RuntimeProtocolErrorData;
} {
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    !Number.isInteger(value.code) ||
    typeof value.message !== "string"
  ) {
    throw new RollProtocolViolationError(`Roll Runtime returned an invalid error for ${context}`);
  }
  const errorData =
    value.data === undefined ? undefined : runtimeProtocolErrorDataSchema.safeParse(value.data);
  if (errorData !== undefined && !errorData.success) {
    throw new RollProtocolViolationError(
      `Roll Runtime returned invalid error data for ${context}`,
      errorData.error,
    );
  }
  return {
    code: value.code,
    message: value.message,
    ...(errorData?.success === true ? { data: errorData.data } : {}),
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
  private readonly advertisedProtocolVersions: readonly RuntimeProtocolVersion[];
  private readonly inFlightServerRequests = new Map<JsonRpcId, InFlightServerRequest>();
  private readonly onTurnOutcomeUnknown: ((turnId: TurnId) => void) | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly readRetryDelayMs: number;
  private readonly defaultShutdownOptions: NormalizedRuntimeShutdownOptions;
  private readonly outputReader: ReturnType<typeof createInterface>;
  private readonly stderrReader: ReturnType<typeof createInterface> | undefined;
  private requestId = 0;
  private writeQueue = Promise.resolve();
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

  private constructor(options: ConnectRuntimeClientOptions) {
    this.transport = options.transport;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.outboundMaxFrameBytes = this.maxFrameBytes;
    this.onTurnOutcomeUnknown = options.onTurnOutcomeUnknown;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxReadRetries = options.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES;
    this.readRetryDelayMs = options.readRetryDelayMs ?? DEFAULT_READ_RETRY_DELAY_MS;
    this.defaultShutdownOptions = normalizeShutdownOptions(options.shutdownOptions);
    this.serverRequestHandlers = { ...options.serverRequestHandlers };
    this.advertisedProtocolVersions = SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.filter((version) =>
      supportsRuntimeProtocolVersion(version, this.serverRequestHandlers),
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

  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
    if (!isRuntimeServerRequestMethod(method)) {
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
    this.serverRequestHandlers[method] = handler;
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
    };
  }

  async request<TMethod extends RuntimeMethod>(
    method: TMethod,
    input: RuntimeMethodInput<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>> {
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
    const params = parseRuntimeMethodParams(method, input);
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
        return await this.requestOnce(method, params);
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

  private async requestOnce<TMethod extends RuntimeMethod>(
    method: TMethod,
    params: RuntimeMethodParams<TMethod>,
  ): Promise<RuntimeMethodResult<TMethod>> {
    const id = this.requestId;
    this.requestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new RollRequestTimeoutError(method, this.requestTimeoutMs));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
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
        return parseRuntimeMethodResult(method, result);
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
          new RollUncorrelatedRpcError(parseRpcError(parsed.error, "an uncorrelated request")),
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
        rpcError = new RollRpcError(parseRpcError(parsed.error, `"${pending.method}"`));
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
        this.acceptInitializationResult(
          parseRuntimeMethodResult(RUNTIME_METHODS.initialize, parsed.result),
        );
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
      if (
        this.initializationResult === undefined ||
        !getRuntimeProtocolCapabilities(this.initializationResult.protocolVersion).serverRequests
      ) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime emitted runtime.serverRequest.cancel outside a negotiated " +
              "server-request capability",
          ),
        );
        return;
      }
      const cancellation = runtimeServerRequestCancelParamsSchema.safeParse(params);
      if (!cancellation.success) {
        this.failProtocol(
          new RollProtocolViolationError(
            "Roll Runtime emitted an invalid runtime.serverRequest.cancel",
            cancellation.error,
          ),
        );
        return;
      }
      const inFlight = this.inFlightServerRequests.get(cancellation.data.serverRequestId);
      if (inFlight !== undefined) {
        this.inFlightServerRequests.delete(cancellation.data.serverRequestId);
        inFlight.controller.abort(new Error(cancellation.data.reason));
      }
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
    if (
      this.initializationResult === undefined ||
      !getRuntimeProtocolCapabilities(this.initializationResult.protocolVersion).serverRequests ||
      !isRuntimeServerRequestMethod(method)
    ) {
      this.observeServerRequestResponse(
        this.writeServerRequestError(id, JSON_RPC_ERROR_CODES.methodNotFound, "Method not found"),
      );
      return;
    }
    const handler = this.serverRequestHandlers[method];
    if (handler === undefined) {
      this.observeServerRequestResponse(
        this.writeServerRequestError(id, JSON_RPC_ERROR_CODES.methodNotFound, "Method not found"),
      );
      return;
    }
    this.observeServerRequestResponse(this.dispatchServerRequest(id, method, params, handler));
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
    id: JsonRpcId,
    method: TMethod,
    input: unknown,
    handler: RuntimeServerRequestHandler<TMethod>,
  ): Promise<void> {
    const inFlight = { controller: new AbortController() };
    this.inFlightServerRequests.set(id, inFlight);
    try {
      let params: RuntimeServerRequestParams<TMethod>;
      try {
        params = parseRuntimeServerRequestParams(method, input);
      } catch {
        await this.writeServerRequestError(
          id,
          JSON_RPC_ERROR_CODES.invalidParams,
          "Invalid params",
          () => this.isServerRequestActive(id, inFlight),
        );
        return;
      }
      let rawResult: RuntimeServerRequestResult<TMethod>;
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
      let result: RuntimeServerRequestResult<TMethod>;
      try {
        result = parseRuntimeServerRequestResult(method, rawResult);
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
      if (this.inFlightServerRequests.get(id) === inFlight) {
        this.inFlightServerRequests.delete(id);
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
