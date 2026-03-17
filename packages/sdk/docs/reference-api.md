# SDK API Reference

`@roll-agent/sdk` 当前导出如下 API。

## `defineTool<TInput, TOutput>(definition)`

定义一个类型安全的 tool。

### 参数

- `definition.name: string` tool 名称
- `definition.description: string` tool 描述
- `definition.input: z.ZodType<TInput>` 输入 schema
- `definition.output: z.ZodType<TOutput>` 输出 schema
- `definition.execute: (input: TInput, ctx: AgentContext) => Promise<TOutput>`

### 返回

- `ToolDefinition<TInput, TOutput>`

### 约束

- 返回值应为可 JSON 序列化对象（SDK 会将结果转换为文本内容传输）。

## `defineAgent(definition, options?)`

定义并返回可运行 Agent。

### 参数

- `definition.name: string` agent 名称
- `definition.tools: ReadonlyArray<AnyToolDefinition>`
- `options.logLevel?: "debug" | "info" | "warn" | "error"`（默认 `info`）

### 返回

- `RunnableAgent`
- 主要方法：`listen(): Promise<void>`

### `listen()` 行为

1. 创建 MCP Server
2. 注册所有 tools
3. 通过 stdio transport 启动
4. 监听 `SIGINT` / `SIGTERM` 优雅退出

说明：当前 SDK 只内置 `stdio` 服务端启动能力，未直接提供 `streamable-http` server transport。

## `createAgentLogger(agentName, minLevel?)`

创建 Agent 日志器（stderr 输出）。

### 参数

- `agentName: string`
- `minLevel?: LogLevel`（默认 `info`）

### 返回

- `AgentLogger`

## 类型导出

- `ToolDefinition<TInput, TOutput>`
- `AnyToolDefinition`
- `AgentDefinition`
- `RunnableAgent`
- `AgentContext`
- `AgentLogger`
- `AgentLLM`
- `LogLevel`

## `AgentContext`

`execute(input, ctx)` 的 `ctx` 提供：

- `ctx.logger`：结构化日志（stderr）
- `ctx.llm.generateText(prompt)`：通过 MCP Sampling 调用指挥官 LLM

## 版本兼容

- Node.js >= 22.6.0
- ESM only
