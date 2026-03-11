import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AgentDefinition, RunnableAgent, AnyToolDefinition } from "./types/index.ts";
import { createAgentLogger } from "./context.ts";
import type { AgentContext, LogLevel } from "./context.ts";

/** defineAgent 额外选项 */
export interface DefineAgentOptions {
  /** 最低日志级别，默认 "info" */
  readonly logLevel?: LogLevel;
}

/**
 * 创建 AgentContext。
 *
 * - logger: 使用结构化日志，输出到 stderr（避免干扰 stdio 协议）
 * - llm: 当前为 stub（提示需要 MCP Sampling 支持），
 *         当指挥官启用 Sampling capability 后子 Agent 可通过 server.createMessage 访问
 */
function createContext(agentName: string, logLevel: LogLevel): AgentContext {
  return {
    llm: {
      generateText: async (_prompt: string) => {
        throw new Error(
          "LLM context not available. " +
            "Ensure the roll-core client connects with sampling capability enabled.",
        );
      },
    },
    logger: createAgentLogger(agentName, logLevel),
  };
}

/**
 * 定义一个 Agent 并返回可运行实例。
 *
 * `listen()` 会启动一个 MCP Server (stdio 模式)，
 * 将所有 tool 注册为 MCP tool，通过 stdin/stdout 通信。
 */
export function defineAgent(definition: AgentDefinition, options: DefineAgentOptions = {}): RunnableAgent {
  return {
    ...definition,
    listen: async () => {
      const server = new McpServer({
        name: definition.name,
        version: "0.0.1",
      });

      const ctx = createContext(definition.name, options.logLevel ?? "info");

      // 注册所有 tool 到 MCP Server
      for (const tool of definition.tools) {
        registerTool(server, tool, ctx);
      }

      // 启动 stdio 传输
      const transport = new StdioServerTransport();
      await server.connect(transport);
      ctx.logger.info("MCP Server running on stdio");

      // Graceful shutdown：收到 SIGTERM/SIGINT 时清理 MCP Server
      const shutdown = async (signal: string): Promise<void> => {
        ctx.logger.info(`${signal} received, shutting down...`);
        await server.close();
        process.exit(0);
      };
      process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
      process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
    },
  };
}

/** 将单个 tool 注册到 MCP Server */
function registerTool(server: McpServer, tool: AnyToolDefinition, ctx: AgentContext): void {
  // 使用 registerTool API（支持 Zod schema 作为 inputSchema）
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input as z.ZodObject<z.ZodRawShape>,
    },
    async (params: Record<string, unknown>) => {
      const result = await (tool.execute as (input: unknown, ctx: AgentContext) => Promise<unknown>)(
        params,
        ctx,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
