/** Agent 日志级别 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Agent 上下文中的日志接口 */
export interface AgentLogger {
  readonly debug: (message: string) => void;
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

/** Agent 上下文中的 LLM 接口（通过 MCP Sampling 访问指挥官 LLM） */
export interface AgentLLM {
  readonly generateText: (prompt: string) => Promise<string>;
}

/** Agent 运行时上下文 */
export interface AgentContext {
  readonly llm: AgentLLM;
  readonly logger: AgentLogger;
}

/** 日志级别优先级 */
const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * 创建一个基于 stderr 的 Agent Logger。
 *
 * MCP Server 通过 stdio 通信，因此日志必须输出到 stderr 以避免干扰协议。
 */
export function createAgentLogger(agentName: string, minLevel: LogLevel = "info"): AgentLogger {
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];

  const write = (level: LogLevel, message: string): void => {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) return;
    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    console.error(`${timestamp} [${tag}] [${agentName}] ${message}`);
  };

  return {
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
