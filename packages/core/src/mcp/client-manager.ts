import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { AgentTransport } from "../types/agent.ts";
import { registerSamplingHandler } from "./sampling-handler.ts";
import type { SamplingHandlerController } from "./sampling-handler.ts";

/** 默认连接超时（毫秒） */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_SESSION_TERMINATION_TIMEOUT_MS = 2_000;
const EXPERIMENTAL_WARNING_SUPPRESSION_FLAG = "--disable-warning=ExperimentalWarning";
type StdioAgentTransport = Extract<AgentTransport, { readonly type: "stdio" }>;

interface CloseOnceTransport {
  close(): Promise<void>;
}

class CloseOnceStdioClientTransport extends StdioClientTransport implements CloseOnceTransport {
  private closePromise: Promise<void> | undefined;

  override close(): Promise<void> {
    this.closePromise ??= super.close();
    return this.closePromise;
  }
}

class CloseOnceStreamableHTTPClientTransport
  extends StreamableHTTPClientTransport
  implements CloseOnceTransport
{
  private closePromise: Promise<void> | undefined;

  override close(): Promise<void> {
    this.closePromise ??= super.close();
    return this.closePromise;
  }
}

interface ConnectionGeneration {
  readonly consumers: Set<symbol>;
  committed: boolean;
  cleanupRequested: boolean;
  closing: boolean;
  connection?: ManagedConnection;
}

/** MCP 客户端连接信息 */
interface ManagedConnection {
  readonly client: Client;
  readonly transportType: "stdio" | "streamable-http";
  readonly httpTransport?: CloseOnceStreamableHTTPClientTransport;
  readonly samplingController?: SamplingHandlerController;
  readonly generation: ConnectionGeneration;
  closePromise?: Promise<void>;
}

interface PendingConnection {
  readonly promise: Promise<ManagedConnection>;
  readonly abortController: AbortController;
  readonly generation: ConnectionGeneration;
}

export interface ConnectOptions {
  /** 连接超时（毫秒），默认 30s */
  readonly timeoutMs?: number;
  /** 取消当前调用；若本调用发起底层连接，也会取消该连接 */
  readonly signal?: AbortSignal;
  /** 为子 Agent 提供的 LLM model（启用 Sampling 支持） */
  readonly samplingModel?: LanguageModelV4;
  /** Sampling 调用的 provider 级参数（如 reasoning/thinking effort） */
  readonly samplingProviderOptions?: SharedV4ProviderOptions;
  /** 注入到 stdio 子进程的环境变量（与 process.env 合并） */
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpConnectionAcquisition {
  readonly client: Client;
  /** 将本次初始化结果提交给 Manager，连接转为可长期复用。 */
  commit(): void;
  /** 放弃本次初始化；仅当同代连接无人使用且从未提交时才关闭。 */
  rollback(): Promise<void>;
}

export interface McpClientManagerOptions {
  /** 仅供内部测试/清理调优；不属于 roll.config.yaml。 */
  readonly httpSessionTerminationTimeoutMs?: number;
}

export function buildStdioChildEnv(env?: Readonly<Record<string, string>>): Record<string, string> {
  const baseEnv = { ...process.env, ...(env ?? {}) } as Record<string, string>;

  return {
    ...baseEnv,
    NODE_OPTIONS: appendNodeOption(baseEnv["NODE_OPTIONS"], EXPERIMENTAL_WARNING_SUPPRESSION_FLAG),
    ROLL_AGENT_LOG_LEVEL: baseEnv["ROLL_AGENT_LOG_LEVEL"] ?? "warn",
    PYTHONUTF8: baseEnv["PYTHONUTF8"] ?? "1",
    PYTHONIOENCODING: baseEnv["PYTHONIOENCODING"] ?? "utf-8",
  };
}

function appendNodeOption(current: string | undefined, option: string): string {
  const normalized = current?.trim();
  if (!normalized) {
    return option;
  }

  const flags = normalized.split(/\s+/);
  if (flags.includes("--no-warnings") || flags.includes(option)) {
    return normalized;
  }

  return `${normalized} ${option}`;
}

export function shouldSuppressStdioChildStderrLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.includes("ExperimentalWarning:") ||
    trimmed.startsWith("(Use `node --trace-warnings") ||
    /\[INFO\s*\]\s*\[[^\]]+\]\s*MCP Server running on stdio$/.test(trimmed)
  );
}

function createStdioTransport(
  transport: StdioAgentTransport,
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Transport {
  const stdioTransport = new CloseOnceStdioClientTransport({
    command: transport.command,
    args: [...(transport.args ?? [])],
    cwd,
    env: buildStdioChildEnv(env),
    stderr: "pipe",
    ...(transport.maxBufferSize !== undefined ? { maxBufferSize: transport.maxBufferSize } : {}),
  });
  pipeFilteredStdioChildStderr(stdioTransport);
  return stdioTransport as Transport;
}

function pipeFilteredStdioChildStderr(transport: StdioClientTransport): void {
  const stderr = transport.stderr;
  if (!stderr) {
    return;
  }

  let buffered = "";
  const flushLine = (line: string): void => {
    if (!shouldSuppressStdioChildStderrLine(line)) {
      process.stderr.write(`${line}\n`);
    }
  };

  stderr.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      flushLine(line);
    }
  });
  stderr.on("end", () => {
    if (buffered.length > 0) {
      flushLine(buffered);
      buffered = "";
    }
  });
}

/**
 * MCP Client Manager — 管理到子 Agent MCP Server 的连接。
 *
 * 支持两种传输模式：
 * - stdio：spawn 子进程，通过 stdin/stdout 通信
 * - streamable-http：连接到远程 HTTP MCP Server
 *
 * 连接按 agent name 缓存复用，disconnect 时清理。
 */
export class McpClientManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly httpSessionTerminationTimeoutMs: number;

  constructor(options: McpClientManagerOptions = {}) {
    const timeoutMs =
      options.httpSessionTerminationTimeoutMs ?? DEFAULT_HTTP_SESSION_TERMINATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("httpSessionTerminationTimeoutMs must be a positive safe integer");
    }
    this.httpSessionTerminationTimeoutMs = timeoutMs;
  }

  /**
   * 获取或创建到指定 Agent 的 MCP 连接。
   *
   * @param cwd 仅 stdio 模式使用，作为子进程工作目录
   */
  async connect(
    agentName: string,
    transport: AgentTransport,
    cwd: string,
    options: ConnectOptions = {},
  ): Promise<Client> {
    const acquisition = await this.connectWithOwnership(agentName, transport, cwd, options);
    try {
      acquisition.commit();
      return acquisition.client;
    } catch (error) {
      await acquisition.rollback();
      throw error;
    }
  }

  /**
   * 获取或创建到指定 Agent 的 MCP 连接，并返回一次初始化 acquisition。
   *
   * 调用方必须在自己的初始化步骤完成后调用 commit()，失败时调用 rollback()。
   * 并发 acquisition 共享同代连接；一个失败方不会关闭仍被其他 acquisition 使用的连接。
   */
  async connectWithOwnership(
    agentName: string,
    transport: AgentTransport,
    cwd: string,
    options: ConnectOptions = {},
  ): Promise<McpConnectionAcquisition> {
    options.signal?.throwIfAborted();

    const existing = this.connections.get(agentName);
    if (existing) {
      const token = this.registerConsumer(existing.generation);
      return this.createAcquisition(agentName, existing, token);
    }

    const pending = this.pendingConnections.get(agentName);
    if (pending !== undefined) {
      const token = this.registerConsumer(pending.generation);
      try {
        const connection = await waitForPendingConnection(pending.promise, options.signal);
        options.signal?.throwIfAborted();
        return this.createAcquisition(agentName, connection, token);
      } catch (error) {
        pending.generation.consumers.delete(token);
        await this.closeGenerationIfUnused(agentName, pending.generation);
        throw error;
      }
    }

    const generation: ConnectionGeneration = {
      consumers: new Set(),
      committed: false,
      cleanupRequested: false,
      closing: false,
    };
    const token = this.registerConsumer(generation);
    const abortController = new AbortController();
    const signal =
      options.signal === undefined
        ? abortController.signal
        : AbortSignal.any([options.signal, abortController.signal]);
    const promise = this.connectNew(
      agentName,
      transport,
      cwd,
      {
        ...options,
        signal,
      },
      generation,
    );
    const ownedPending = { promise, abortController, generation };
    this.pendingConnections.set(agentName, ownedPending);

    try {
      const connection = await promise;
      return this.createAcquisition(agentName, connection, token);
    } catch (error) {
      generation.consumers.delete(token);
      throw error;
    } finally {
      if (this.pendingConnections.get(agentName) === ownedPending) {
        this.pendingConnections.delete(agentName);
      }
    }
  }

  private async connectNew(
    agentName: string,
    transport: AgentTransport,
    cwd: string,
    options: ConnectOptions,
    generation: ConnectionGeneration,
  ): Promise<ManagedConnection> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const samplingCapabilities = options.samplingModel ? { sampling: {} } : {};
    const client = this.createClient(agentName, samplingCapabilities);

    // 注册 Sampling Handler（子 Agent 可通过 createMessage 使用指挥官 LLM）
    const samplingController = options.samplingModel
      ? registerSamplingHandler(client, options.samplingModel, options.samplingProviderOptions)
      : undefined;

    let httpTransport: CloseOnceStreamableHTTPClientTransport | undefined;
    let httpEndpoint: URL | undefined;
    let mcpTransport: Transport;
    if (transport.type === "streamable-http") {
      httpEndpoint = new URL(transport.endpoint);
      httpTransport = new CloseOnceStreamableHTTPClientTransport(httpEndpoint);
      // 强制转换为 Transport 以绕过 exactOptionalPropertyTypes 与库类型的不兼容。
      mcpTransport = httpTransport as Transport;
    } else {
      mcpTransport = createStdioTransport(transport, cwd, options.env);
    }

    try {
      await client.connect(mcpTransport, {
        timeout: timeoutMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
    } catch (error) {
      await this.cleanupFailedConnection(
        agentName,
        client,
        mcpTransport,
        httpTransport,
        httpEndpoint,
        error,
      );
      throw error;
    }

    const connection: ManagedConnection = {
      client,
      transportType: transport.type,
      ...(httpTransport ? { httpTransport } : {}),
      ...(samplingController ? { samplingController } : {}),
      generation,
    };
    generation.connection = connection;
    options.signal?.throwIfAborted();
    if (generation.closing) {
      await this.closeManagedConnection(agentName, connection);
      throw new Error(`Connection to "${agentName}" was cancelled during disconnect.`);
    }
    this.connections.set(agentName, connection);
    return connection;
  }

  private registerConsumer(generation: ConnectionGeneration): symbol {
    if (generation.closing) {
      throw new Error("MCP connection generation is closing");
    }
    const token = Symbol("mcp-connection-acquisition");
    generation.consumers.add(token);
    return token;
  }

  private createAcquisition(
    agentName: string,
    connection: ManagedConnection,
    token: symbol,
  ): McpConnectionAcquisition {
    const { generation } = connection;
    let active = true;
    return {
      client: connection.client,
      commit: () => {
        if (!active) return;
        if (generation.closing) {
          throw new Error(`Connection to "${agentName}" is closing`);
        }
        active = false;
        generation.committed = true;
        generation.consumers.delete(token);
      },
      rollback: async () => {
        if (!active) return;
        active = false;
        generation.cleanupRequested = true;
        generation.consumers.delete(token);
        await this.closeGenerationIfUnused(agentName, generation);
      },
    };
  }

  private async closeGenerationIfUnused(
    agentName: string,
    generation: ConnectionGeneration,
  ): Promise<void> {
    if (
      generation.closing ||
      generation.committed ||
      !generation.cleanupRequested ||
      generation.consumers.size > 0 ||
      generation.connection === undefined
    ) {
      return;
    }
    generation.closing = true;
    const connection = generation.connection;
    if (this.connections.get(agentName) === connection) {
      this.connections.delete(agentName);
    }
    await this.closeManagedConnection(agentName, connection);
  }

  private createClient(
    agentName: string,
    capabilities: { readonly sampling?: Record<string, never> },
  ): Client {
    return new Client({ name: `roll-client-${agentName}`, version: "0.0.1" }, { capabilities });
  }

  private async cleanupFailedConnection(
    agentName: string,
    client: Client,
    transport: Transport,
    httpTransport: CloseOnceStreamableHTTPClientTransport | undefined,
    httpEndpoint: URL | undefined,
    connectionError: unknown,
  ): Promise<void> {
    const cleanupErrors: unknown[] = [];
    if (httpTransport?.sessionId !== undefined && httpEndpoint !== undefined) {
      const terminationTransport = new CloseOnceStreamableHTTPClientTransport(httpEndpoint, {
        sessionId: httpTransport.sessionId,
      });
      if (httpTransport.protocolVersion !== undefined) {
        terminationTransport.setProtocolVersion(httpTransport.protocolVersion);
      }
      try {
        await terminationTransport.start();
        await this.terminateHttpSession(agentName, terminationTransport);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await terminationTransport.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await client.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await transport.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [connectionError, ...cleanupErrors],
        `Connection to "${agentName}" failed and MCP cleanup also failed.`,
      );
    }
  }

  private async terminateHttpSession(
    agentName: string,
    transport: CloseOnceStreamableHTTPClientTransport,
  ): Promise<void> {
    if (transport.sessionId === undefined) return;

    let timedOut = false;
    let forcedClose: Promise<void> | undefined;
    const timeoutError = new Error(
      `HTTP session cleanup for "${agentName}" timed out after ${String(
        this.httpSessionTerminationTimeoutMs,
      )}ms`,
    );
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      forcedClose = Promise.resolve().then(() => transport.close());
    }, this.httpSessionTerminationTimeoutMs);

    try {
      await transport.terminateSession();
    } catch (error) {
      if (!timedOut) throw error;
      try {
        await forcedClose;
      } catch (closeError) {
        throw new AggregateError(
          [timeoutError, closeError],
          `HTTP session cleanup and forced close both failed for "${agentName}".`,
        );
      }
      throw timeoutError;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (timedOut) {
      try {
        await forcedClose;
      } catch (closeError) {
        throw new AggregateError(
          [timeoutError, closeError],
          `HTTP session cleanup and forced close both failed for "${agentName}".`,
        );
      }
      throw timeoutError;
    }
  }

  private closeManagedConnection(agentName: string, connection: ManagedConnection): Promise<void> {
    connection.closePromise ??= (async () => {
      const errors: unknown[] = [];
      if (connection.httpTransport?.sessionId !== undefined) {
        try {
          await this.terminateHttpSession(agentName, connection.httpTransport);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await connection.client.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `MCP connection cleanup failed for "${agentName}".`);
      }
    })();
    return connection.closePromise;
  }

  /** 更新全部已连接 Agent 后续 Sampling 请求使用的 provider 参数。 */
  setSamplingProviderOptions(providerOptions: SharedV4ProviderOptions | undefined): void {
    for (const connection of this.connections.values()) {
      connection.samplingController?.setProviderOptions(providerOptions);
    }
  }

  /** 更新全部已连接 Agent 后续 Sampling 请求使用的模型。 */
  setSamplingModel(model: LanguageModelV4): void {
    for (const connection of this.connections.values()) {
      connection.samplingController?.setModel(model);
    }
  }

  /** 断开指定 Agent 的连接 */
  async disconnect(agentName: string, expectedClient?: Client): Promise<void> {
    if (expectedClient === undefined) {
      const pending = this.pendingConnections.get(agentName);
      if (pending !== undefined) {
        pending.generation.closing = true;
        pending.abortController.abort(
          new Error(`Connection to "${agentName}" was cancelled during disconnect.`),
        );
        await pending.promise.catch(() => {});
      }
    }

    const conn = this.connections.get(agentName);
    if (!conn || (expectedClient !== undefined && conn.client !== expectedClient)) return;
    conn.generation.closing = true;
    if (this.connections.get(agentName) === conn) {
      this.connections.delete(agentName);
    }
    await this.closeManagedConnection(agentName, conn);
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    const pendingEntries = [...this.pendingConnections.entries()];
    for (const [agentName, pending] of pendingEntries) {
      pending.generation.closing = true;
      pending.abortController.abort(
        new Error(`Connection to "${agentName}" was cancelled during disconnect.`),
      );
    }
    await Promise.allSettled(pendingEntries.map(([, pending]) => pending.promise));

    const connectionEntries = [...this.connections.entries()];
    for (const [agentName, connection] of connectionEntries) {
      connection.generation.closing = true;
      if (this.connections.get(agentName) === connection) {
        this.connections.delete(agentName);
      }
    }
    const results = await Promise.allSettled(
      connectionEntries.map(([agentName, connection]) =>
        this.closeManagedConnection(agentName, connection),
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple MCP connections failed to close.");
    }
  }

  /** 检查是否已连接 */
  isConnected(agentName: string): boolean {
    return this.connections.has(agentName);
  }
}

function waitForPendingConnection(
  promise: Promise<ManagedConnection>,
  signal: AbortSignal | undefined,
): Promise<ManagedConnection> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted();

  return new Promise<ManagedConnection>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(signal.reason);
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", handleAbort);
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (client) => {
        cleanup();
        resolve(client);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
