import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type {
  AgentDefinition,
  RunnableAgent,
  AnyToolDefinition,
  ListenOptions,
} from "./types/index.ts";
import { createAgentLogger } from "./context.ts";
import type { AgentContext, LogLevel } from "./context.ts";

/** defineAgent 额外选项 */
export interface DefineAgentOptions {
  /** 最低日志级别，默认 "info" */
  readonly logLevel?: LogLevel;
  /** 关闭 MCP Server 之前执行的资源清理回调 */
  readonly onShutdown?: () => Promise<void>;
}

/**
 * 创建 AgentContext。
 *
 * - logger: 使用结构化日志，输出到 stderr（避免干扰 stdio 协议）
 * - llm: 通过 MCP Sampling 请求指挥官 LLM（server.createMessage）
 */
function createContext(agentName: string, logLevel: LogLevel, server: McpServer): AgentContext {
  return {
    llm: {
      generateText: async (prompt: string) => {
        try {
          const response = await server.server.createMessage({
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: prompt,
                },
              },
            ],
            maxTokens: 1024,
          });

          const text = extractSamplingText(response.content);
          if (text === undefined) {
            throw new Error("Sampling response did not include text content");
          }
          return text;
        } catch (error) {
          throw new Error(
            "LLM sampling unavailable. Ensure roll-core client enables sampling capability.",
            { cause: error },
          );
        }
      },
    },
    logger: createAgentLogger(agentName, logLevel),
  };
}

function extractSamplingText(content: unknown): string | undefined {
  if (typeof content === "object" && content !== null) {
    if ("type" in content && content.type === "text" && "text" in content) {
      const text = (content as { text?: unknown }).text;
      return typeof text === "string" ? text : undefined;
    }
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      const text = extractSamplingText(item);
      if (text !== undefined) {
        return text;
      }
    }
  }

  return undefined;
}

/**
 * 定义一个 Agent 并返回可运行实例。
 *
 * `listen()` 支持两种传输模式：
 * - stdio（默认）：通过 stdin/stdout 通信，适合 roll-core 以子进程方式调用
 * - http：启动 Streamable HTTP 服务，适合浏览器 Agent 等需要持久进程的场景
 */
export function defineAgent(
  definition: AgentDefinition,
  options: DefineAgentOptions = {},
): RunnableAgent {
  return {
    ...definition,
    listen: async (listenOptions?: ListenOptions) => {
      const transport = listenOptions?.transport ?? { type: "stdio" as const };
      const logLevel = options.logLevel ?? "info";

      if (transport.type === "http") {
        await listenHttp(definition, logLevel, transport.port, transport.host, options.onShutdown);
      } else {
        await listenStdio(definition, logLevel, options.onShutdown);
      }
    },
  };
}

function registerShutdownHandlers(shutdown: (signal: string) => Promise<void>): void {
  let inFlightShutdown: Promise<void> | undefined;

  const handleSignal = (signal: string): void => {
    inFlightShutdown ??= shutdown(signal).catch(() => {
      process.exit(1);
    });
  };

  process.once("SIGTERM", () => {
    handleSignal("SIGTERM");
  });
  process.once("SIGINT", () => {
    handleSignal("SIGINT");
  });
}

// ========== Stdio Transport ==========

async function listenStdio(
  definition: AgentDefinition,
  logLevel: LogLevel,
  onShutdown?: () => Promise<void>,
): Promise<void> {
  const server = new McpServer({
    name: definition.name,
    version: "0.0.1",
  });

  const ctx = createContext(definition.name, logLevel, server);

  for (const tool of definition.tools) {
    registerTool(server, tool, ctx);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  ctx.logger.info("MCP Server running on stdio");

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info(`${signal} received, shutting down...`);
    if (onShutdown) {
      await onShutdown();
    }
    await server.close();
    process.exit(0);
  };
  registerShutdownHandlers(shutdown);
}

// ========== HTTP Transport ==========

/**
 * 启动 Streamable HTTP MCP Server。
 *
 * 每个客户端 session 独立创建 McpServer + StreamableHTTPServerTransport，
 * 因为 McpServer.connect(transport) 是 1:1 绑定。
 * 但所有 session 共享同一个 AgentContext 的模块级状态（如 BrowserRuntime）。
 */
async function listenHttp(
  definition: AgentDefinition,
  logLevel: LogLevel,
  port: number,
  host?: string,
  onShutdown?: () => Promise<void>,
): Promise<void> {
  const logger = createAgentLogger(definition.name, logLevel);

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // 只处理 /mcp 路径
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const sessionId =
      typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;

    // 已有 session → 路由到对应 transport
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        try {
          await session.transport.handleRequest(req, res);
        } catch (err) {
          logger.error(`Error handling request for session ${sessionId}: ${String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
        return;
      }
      // session ID 未找到 → 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    // 无 session ID → 新建 session
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const mcpServer = new McpServer({
        name: definition.name,
        version: "0.0.1",
      });

      const ctx = createContext(definition.name, logLevel, mcpServer);
      for (const tool of definition.tools) {
        registerTool(mcpServer, tool, ctx);
      }

      // onclose / onerror 必须在 connect() 之前设置，避免竞态
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) {
          sessions.delete(id);
          logger.info(`Session ${id} closed`);
        }
      };

      transport.onerror = (err: Error) => {
        logger.error(
          `Transport error (session ${transport.sessionId ?? "unknown"}): ${err.message}`,
        );
      };

      // MCP SDK 的 StreamableHTTPServerTransport.onclose 类型为 (() => void) | undefined
      // 而 Transport.onclose 期望 () => void（exactOptionalPropertyTypes 不兼容）
      // 这是上游类型定义问题，此处安全地 cast
      await mcpServer.connect(transport as unknown as Transport);

      // 处理当前请求（initialization）— sessionId 在 handleRequest 内由 sessionIdGenerator 生成
      await transport.handleRequest(req, res);

      // Node.js 单线程保证：handleRequest 完成前不会处理下一个 HTTP 请求，
      // 因此这里注册 session 不存在竞态
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server: mcpServer });
      }
    } catch (err) {
      logger.error(`Error creating new session: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to create session" }));
      }
    }
  });

  // HTTP server 错误处理
  httpServer.on("error", (err: Error) => {
    logger.error(`HTTP server error: ${err.message}`);
  });

  const listenHost = host ?? "127.0.0.1";

  httpServer.listen(port, listenHost, () => {
    logger.info(`MCP Server running on http://${listenHost}:${port}/mcp`);
  });

  // Graceful shutdown：先停止接收新请求 → 再关闭 MCP session
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down HTTP server...`);

    // 1. 停止接收新连接
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    // 2. 关闭所有 MCP session
    const closePromises: Array<Promise<void>> = [];
    for (const [, session] of sessions) {
      closePromises.push(session.server.close());
    }
    await Promise.all(closePromises);
    sessions.clear();

    if (onShutdown) {
      await onShutdown();
    }

    process.exit(0);
  };

  registerShutdownHandlers(shutdown);
}

// ========== Tool Registration ==========

/** 将单个 tool 注册到 MCP Server */
function registerTool(server: McpServer, tool: AnyToolDefinition, ctx: AgentContext): void {
  // MCP SDK 的 registerTool 要求 ZodObject，但 AnyToolDefinition.input 是更宽泛的 ZodType（类型擦除代价）
  // AnyToolDefinition.execute 签名为 (never, ctx) 以阻止直接调用，注册时需转型为可调用签名
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input as z.ZodObject<z.ZodRawShape>,
    },
    async (params: Record<string, unknown>) => {
      const result = await (
        tool.execute as (input: unknown, ctx: AgentContext) => Promise<unknown>
      )(params, ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
