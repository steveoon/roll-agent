import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AgentDefinition, RunnableAgent, AnyToolDefinition } from "./types/index.ts";
import type { AgentContext } from "./context.ts";

/** 创建一个 stub AgentContext（当前阶段不支持 Sampling） */
function createStubContext(): AgentContext {
  return {
    llm: {
      generateText: async (_prompt: string) => {
        throw new Error("LLM context not available yet (requires MCP Sampling)");
      },
    },
    logger: {
      info: (message: string) => console.error(`[info] ${message}`),
      error: (message: string) => console.error(`[error] ${message}`),
    },
  };
}

/**
 * 定义一个 Agent 并返回可运行实例。
 *
 * `listen()` 会启动一个 MCP Server (stdio 模式)，
 * 将所有 tool 注册为 MCP tool，通过 stdin/stdout 通信。
 */
export function defineAgent(definition: AgentDefinition): RunnableAgent {
  return {
    ...definition,
    listen: async () => {
      const server = new McpServer({
        name: definition.name,
        version: "0.0.1",
      });

      const ctx = createStubContext();

      // 注册所有 tool 到 MCP Server
      for (const tool of definition.tools) {
        registerTool(server, tool, ctx);
      }

      // 启动 stdio 传输
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error(`MCP Server "${definition.name}" running on stdio`);

      // Graceful shutdown：收到 SIGTERM/SIGINT 时清理 MCP Server
      const shutdown = async (signal: string): Promise<void> => {
        console.error(`${signal} received, shutting down MCP Server "${definition.name}"...`);
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
