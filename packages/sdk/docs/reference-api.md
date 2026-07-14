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
- `options.logLevel?: "debug" | "info" | "warn" | "error"`（默认读取 `ROLL_AGENT_LOG_LEVEL`，未设置时为 `info`；显式传入优先级最高）

### 返回

- `RunnableAgent`
- 主要方法：`listen(): Promise<void>`

### `listen()` 行为

1. 创建 MCP Server
2. 注册所有 tools
3. 通过 stdio transport 启动
4. 监听 `SIGINT` / `SIGTERM` 优雅退出

说明：当前 SDK 只内置 `stdio` 服务端启动能力，未直接提供 `streamable-http` server transport。

## Agent 注册约定

SDK 负责定义和运行 stdio Agent，本身不负责注册到 `roll-core`。要让 `roll` 发现你的 Agent，通常还需要：

- 项目根目录的 `SKILL.md`
- `SKILL.md metadata` 中的 `roll-transport` / `roll-command`
- 如果 Agent 需要机器可读的 env 契约，可在 `metadata.roll-env-file` 中指向例如 `references/env.yaml`

说明：

- 本地源码目录 / Git 仓库通常使用 `roll agent add`
- 已发布的已编译 npm 包或 `.tgz` 安装包通常使用 `roll agent install`
- 业务 Agent 自己的运行配置应显式放在 `roll.config.yaml` 的 `agents.env.<agent-name>`，而不是依赖 `roll-core` 的全局 `llm.*`

### `references/env.yaml` 契约

`metadata.roll-env-file` 指向的文件使用以下结构；顶层 `required` 与 `optional` 均可省略，
分别声明必填与非必填字段：

```yaml
required:
  - name: SERVICE_BASE_URL
    purpose: 上游服务地址
    type: url
    example: https://api.example.com
    secret: false
  - name: SERVICE_TOKEN
    purpose: 服务访问令牌
    type: string
    example: token_xxx
    secret: true
optional:
  - name: REQUEST_TIMEOUT_MS
    purpose: 请求超时时间
    type: number
    default: "30000"
    example: "30000"
    secret: false
  - name: BROWSER_INSTANCES_JSON
    purpose: 由浏览器实例配置派生
    type: json
    configurable: false
    sourcePath:
      - browser
      - instances
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 环境变量名。 |
| `purpose` | 否 | 展示给配置 UI / CLI 的用途说明。 |
| `type` | 否 | 可选值为 `string`、`boolean`、`number`、`json`、`url`；省略时按变量名后缀推断。 |
| `example` | 否 | 示例值；环境变量最终仍以字符串持久化。 |
| `default` | 否 | 可选变量的默认值；环境变量最终仍以字符串持久化。 |
| `secret` | 否 | **缺省等同于 `true`（fail-closed）**；非敏感字段必须显式写 `secret: false`。 |
| `configurable` | 否 | 是否允许用户直接配置，通常缺省为 `true`。派生字段应写 `false`；`BROWSER_INSTANCES_JSON` 缺省时由 core 特判为 `false`。 |
| `sourcePath` | 否 | `configurable: false` 时可声明其来源配置路径，使用字符串数组；`BROWSER_INSTANCES_JSON` 缺省时由 core 设为 `browser.instances`。 |

`required` / `optional` 只决定字段是否必须提供，不改变 `secret` 的缺省行为；两类字段省略
`secret` 时都会被当作敏感字段处理。

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
- `ctx.llm.generateText(prompt)`：通过 MCP Sampling 调用指挥官 LLM；当前 SDK 为单次请求声明 `maxTokens: 1024`

`ctx.llm` 的 provider、model 与 reasoning/thinking 档位由指挥官控制。`runtime.thinking-level` 会作用于 `roll ask`、`roll run` 和 `roll chat` 发起的 Sampling；交互式 `roll chat` 使用 `/think`、`/effort` 或对应快捷键切档后，后续 Sampling 请求也使用新档位。SDK 自身不读取 Roll 配置，且指挥官不会为了 thinking budget 主动调大 SDK 请求对应的 `maxOutputTokens`。

注意：这里的 `ctx.llm` 只覆盖“通过 Sampling 借用 roll-core LLM”的场景。如果你的 Agent 自己内嵌了 provider 调用逻辑，那么它的模型、API key、代理地址等配置应由该 Agent 自己显式声明和读取。

## 版本兼容

- Node.js >= 22.6.0
- ESM only
