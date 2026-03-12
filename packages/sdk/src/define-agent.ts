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

      const ctx = createContext(definition.name, options.logLevel ?? "info", server);

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
  // MCP SDK 的 registerTool 要求 ZodObject，但 AnyToolDefinition.input 是更宽泛的 ZodType（类型擦除代价）
  // AnyToolDefinition.execute 签名为 (never, ctx) 以阻止直接调用，注册时需转型为可调用签名
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
