import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentTransport } from "../types/agent.ts";

/** 默认连接超时（毫秒） */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** MCP 客户端连接信息 */
interface ManagedConnection {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

export interface ConnectOptions {
  /** 连接超时（毫秒），默认 30s */
  readonly timeoutMs?: number;
}

/**
 * MCP Client Manager — 管理到子 Agent MCP Server 的连接。
 *
 * 当前支持 stdio 传输模式（spawn 子进程）。
 * 连接按 agent name 缓存复用，disconnect 时清理。
 */
export class McpClientManager {
  private readonly connections = new Map<string, ManagedConnection>();

  /**
   * 获取或创建到指定 Agent 的 MCP 连接。
   *
   * stdio 模式：spawn 子进程，通过 stdin/stdout 通信。
   * 连接有超时保护，防止子进程启动失败时永久挂起。
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

    if (transport.type === "streamable-http") {
      throw new Error(`Streamable HTTP transport not yet implemented for "${agentName}"`);
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const client = new Client({ name: `roll-client-${agentName}`, version: "0.0.1" });

    const stdioTransport = new StdioClientTransport({
      command: transport.command,
      args: [...(transport.args ?? [])],
      cwd,
    });

    // 带超时保护的连接
    const connectPromise = client.connect(stdioTransport);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Connection to "${agentName}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      await Promise.race([connectPromise, timeoutPromise]);
    } catch (err) {
      // 超时或连接失败时清理子进程
      await client.close().catch(() => {});
      throw err;
    }

    this.connections.set(agentName, { client, transport: stdioTransport });
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
