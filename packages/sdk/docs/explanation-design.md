# SDK Design And Architecture

本页解释 `@roll-agent/sdk` 为什么这样设计，以及关键取舍。

## 设计目标

- 降低 Agent 开发门槛：业务开发者不必手写 MCP 协议层
- 保持类型安全：tool 输入输出由 Zod + TypeScript 泛型约束
- 与指挥官解耦：Agent 不直接绑定具体 LLM provider

## 核心抽象

### Tool 抽象

`defineTool` 让每个 tool 以统一结构声明：

- 名称与描述（供发现和路由）
- 输入输出 schema（供校验与类型推导）
- 执行函数（业务逻辑）

这样可以把“协议细节”从“业务函数”中分离出去。

### Agent 抽象

`defineAgent` 将多个 tools 组装成一个 `RunnableAgent`。  
`listen()` 内部负责 MCP Server 创建、tool 注册、stdio 传输启动、信号退出处理。

当前 SDK 故意只封装 `stdio` 服务端路径：

- 适合本地开发和本地已安装产物
- 与 roll-core 当前的按需 `spawn + stdio` 生命周期天然匹配
- 远程 `streamable-http` 更适合作为独立部署问题处理，而不是默认塞进每个 Agent 的最小运行时

## 为什么日志走 stderr

MCP stdio 场景中 stdout 用于协议数据传输。  
若业务日志写到 stdout，会污染协议流并导致通信异常。  
因此 SDK 默认 logger 输出到 stderr。

## 为什么 LLM 通过 Sampling

`ctx.llm.generateText()` 并不在 Agent 内部直连 OpenAI/Anthropic。  
它通过 MCP Sampling 请求 roll-core 执行推理，带来三个好处：

- Agent 不需要管理 provider key
- 模型选择与计费策略集中在指挥官侧
- 多 Agent 共享同一套 LLM 配置与治理策略

代价是：调用方（roll-core）必须在连接时声明 sampling capability。

## 类型设计取舍

- `ToolDefinition<TInput, TOutput>` 提供强类型开发体验
- `AnyToolDefinition` 用于“异构 tool 集合”统一存储与注册

这是一种“开发时强类型、运行时统一接口”的折中方案。
