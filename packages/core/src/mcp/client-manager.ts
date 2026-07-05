import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { AgentTransport } from "../types/agent.ts";
import { registerSamplingHandler } from "./sampling-handler.ts";

/** 默认连接超时（毫秒） */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const EXPERIMENTAL_WARNING_SUPPRESSION_FLAG = "--disable-warning=ExperimentalWarning";
type StdioAgentTransport = Extract<AgentTransport, { readonly type: "stdio" }>;

/** MCP 客户端连接信息 */
interface ManagedConnection {
  readonly client: Client;
  readonly transportType: "stdio" | "streamable-http";
}

export interface ConnectOptions {
  /** 连接超时（毫秒），默认 30s */
  readonly timeoutMs?: number;
  /** 为子 Agent 提供的 LLM model（启用 Sampling 支持） */
  readonly samplingModel?: LanguageModelV4;
  /** 注入到 stdio 子进程的环境变量（与 process.env 合并） */
  readonly env?: Readonly<Record<string, string>>;
}

export function buildStdioChildEnv(env?: Readonly<Record<string, string>>): Record<string, string> {
  const baseEnv = env ? ({ ...process.env, ...env } as Record<string, string>) : {};

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
  const stdioTransport = new StdioClientTransport({
    command: transport.command,
    args: [...(transport.args ?? [])],
    cwd,
    env: buildStdioChildEnv(env),
    stderr: "pipe",
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
    const existing = this.connections.get(agentName);
    if (existing) {
      return existing.client;
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const samplingCapabilities = options.samplingModel ? { sampling: {} } : {};
    const client = new Client(
      { name: `roll-client-${agentName}`, version: "0.0.1" },
      { capabilities: samplingCapabilities },
    );

    // 注册 Sampling Handler（子 Agent 可通过 createMessage 使用指挥官 LLM）
    if (options.samplingModel) {
      registerSamplingHandler(client, options.samplingModel);
    }

    // 创建 MCP 传输（强制转换为 Transport 以绕过 exactOptionalPropertyTypes 与库类型的不兼容）
    const mcpTransport: Transport =
      transport.type === "streamable-http"
        ? (new StreamableHTTPClientTransport(new URL(transport.endpoint)) as Transport)
        : createStdioTransport(transport, cwd, options.env);

    const connectPromise = client.connect(mcpTransport);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Connection to "${agentName}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      await Promise.race([connectPromise, timeoutPromise]);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    this.connections.set(agentName, { client, transportType: transport.type });
    return client;
  }

  /** 断开指定 Agent 的连接 */
  async disconnect(agentName: string): Promise<void> {
    const conn = this.connections.get(agentName);
    if (!conn) return;

    await conn.client.close();
    this.connections.delete(agentName);
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  /** 检查是否已连接 */
  isConnected(agentName: string): boolean {
    return this.connections.has(agentName);
  }
}
