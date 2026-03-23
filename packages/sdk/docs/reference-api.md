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
- `definition.input` 会成为 MCP tool 的 `inputSchema`，被 `roll run` / `roll ask` 直接消费。

### 与 commander 调用模型的关系

- `roll ask` 会先基于 tool 描述做路由，再基于 `definition.input` 的 schema 提取参数
- `roll run` 支持三种输入方式：
  - `--key value`
  - `--input-json '<json-object>'`
  - `--input-file ./payload.json`
- 对于开放对象或复杂 payload，commander 不会擅自猜测结构，而是要求调用方显式提供输入

### 输入 schema 设计建议

- 优先使用字段清晰、描述明确的对象 schema，这样 `roll ask` 才能按字段名稳定提参
- 如果输入包含开放对象、任意键值映射或复杂 JSON payload（例如 `z.record(...)`），`roll ask` 不会尝试凭自然语言臆造这些字段，而会要求调用方改用 `roll run --input-json` / `--input-file` 或上游编排器显式提供
- 为每个可自然语言提取的字段补充 `description`，能显著提升 `roll ask` 的参数提取质量

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
