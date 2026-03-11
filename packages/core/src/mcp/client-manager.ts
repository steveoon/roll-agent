import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentTransport } from "../types/agent.ts";

/** MCP 客户端连接信息 */
interface ManagedConnection {
  readonly client: Client;
  readonly transport: StdioClientTransport;
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
   */
  async connect(agentName: string, transport: AgentTransport, cwd: string): Promise<Client> {
    const existing = this.connections.get(agentName);
    if (existing) {
      return existing.client;
    }

    if (transport.type === "streamable-http") {
      throw new Error(`Streamable HTTP transport not yet implemented for "${agentName}"`);
    }

    const client = new Client({ name: `roll-client-${agentName}`, version: "0.0.1" });

    const stdioTransport = new StdioClientTransport({
      command: transport.command,
      args: [...(transport.args ?? [])],
      cwd,
    });

    await client.connect(stdioTransport);

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
