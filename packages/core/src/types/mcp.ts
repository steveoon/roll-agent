/** MCP 连接信息 */
export interface McpConnection {
  readonly agentName: string;
  readonly transport: "stdio" | "streamable-http";
  readonly connected: boolean;
}
