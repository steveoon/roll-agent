# SDK Design And Architecture

本页解释 `@roll-agent/sdk` 为什么这样设计，以及关键取舍。

## 设计目标

- 降低 Agent 开发门槛：业务开发者不必手写 MCP 协议层
- 保持类型安全：tool 输入输出由 Zod + TypeScript 泛型约束
- 与指挥官解耦：Agent 不直接绑定具体 LLM provider

## 核心抽象

最近这套架构又补齐了几个关键能力：

- 路由结果拆成了“先选 tool 的 `RouteSelection`”和“带输入可执行的 `RouteDecision`”
- commander 新增了 `tool-runtime` 适配层，统一负责参数提取、preflight 校验和调用前错误分类
- `ask` 改成两阶段：路由与提参分离
- `run` 增加了显式结构化输入能力：`--input-json` / `--input-file`

### Tool 抽象

`defineTool` 让每个 tool 以统一结构声明：

- 名称与描述（供发现和路由）
- 输入输出 schema（供校验与类型推导）
- 执行函数（业务逻辑）

这样可以把“协议细节”从“业务函数”中分离出去。

`roll-core` 对 tool 的调用也依赖这层 schema：`roll ask` 会先选择 tool，再按 tool 的 `inputSchema` 提取参数。因此，输入 schema 不只是类型定义，也是 commander 的调用契约。

这带来一个重要约束：

- 字段明确、描述充分的对象 schema，适合 `roll ask` 从自然语言提参
- 开放对象、任意 map、复杂 JSON payload，不适合让 `ask` 猜测

因此 commander 采用的原则是：**原始 `inputSchema` 的类型语义不可被提参适配层篡改。** 如果某个必填字段无法从自然语言可靠提取（例如 `z.record()`），`ask` 会返回需要显式输入，而不是把 `object` 偷换成 `string` 之类的伪兼容 schema。

这也是为什么：

- 面向自然语言的 tool，应该尽量使用字段清晰的输入对象
- 面向程序化调用的 tool，应该明确支持 `roll run --input-json` / `--input-file`

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

## 为什么业务 Agent 的 env 配置要保持显式

并不是所有 Agent 都只通过 `ctx.llm.generateText()` 借用指挥官的 LLM。有些业务 Agent 会在内部直接访问自己的 provider、模型或后端 API。

这类配置不应自动继承 `roll-core` 的全局 `llm.*`，原因有三点：

- 职责边界更清晰：`roll-core` 的 `llm.*` 只描述 commander 自己的路由与 Sampling 行为
- 业务 Agent 更可移植：它需要什么 env，应由自己的 skill 契约显式声明
- 诊断更可解释：上层编排器和用户可以直接在 `agents.env.<agent-name>` 中看到业务 Agent 的真实依赖

因此推荐的模式是：

- 在 `SKILL.md` 中保留人类可读的配置说明
- 用 `metadata.roll-env-file` 指向 `references/env.yaml` 之类的 sidecar 文件，声明机器可读的 env 契约
- 让 `roll-core` 负责检查和提示这些 env 是否缺失，而不是替业务 Agent 自动猜测或注入配置

## 类型设计取舍

- `ToolDefinition<TInput, TOutput>` 提供强类型开发体验
- `AnyToolDefinition` 用于“异构 tool 集合”统一存储与注册

这是一种“开发时强类型、运行时统一接口”的折中方案。
