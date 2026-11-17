# 架构与宿主集成契约

改变包职责、Core/Runtime/Protocol 边界、Agent 注册与集成或 SDK 公开契约时读取。

本文承接根 [AGENTS.md](../../AGENTS.md) 的专项工程约定。下文源码路径均相对于仓库根目录。

## Monorepo 结构（pnpm workspace）

| 包 | 作用 |
| --- | --- |
| `packages/core` | CLI（citty）、配置、Registry/Router、MCP/LLM 接线、Runtime/Scheduler/Companion host、React 配置台 |
| `packages/runtime` | ConversationEngine、AgentSession、ThreadStore、审批策略、Tool Bridge、Runtime Service、scheduler 账本 |
| `packages/protocol` | Runtime JSON-RPC 协议版本、Schema、事件与交互契约 |
| `packages/client-node` | Node/Electron Main 使用的 Runtime Client 与 stdio 子进程传输 |
| `packages/companion` | Local Companion 的 Relay bridge、buffer、Workspace lease 与加密低层库 |
| `packages/relay-protocol` | Cloud Relay Wire/Control 契约、Schema 与 conformance fixtures |
| `packages/relay-client` | Browser-safe Relay Client 与短期 session 接入 |
| `packages/sdk` | 子 Agent 开发 SDK：`defineAgent()` + `defineTool()` |
| `packages/browser` | 浏览器运行时抽象层：BrowserRuntime + ContextManager + SessionStore |
| `packages/reply-authority-client` | Reply Authority 签名 envelope 客户端 |
| `agents/browser-use` | 浏览器操控 Agent（streamable-http 常驻服务） |
| `agents/smart-reply` | 智能回复 Agent（stdio 按需模式） |
| `agents/notify` | 私有通知 Agent（stdio 按需模式） |

## Agent 三层模型

Agent 注册信息由三个维度描述：

- `source`：`local-path` | `git` | `installed-package` | `remote-manifest`
- `transport`：`stdio` | `streamable-http`
- `runtime ownership`：`on-demand` | `core-managed` | `external-managed`

可安装的 Agent 通过 `package.json#rollAgent` 声明运行时启动信息，其优先级高于 `SKILL.md` frontmatter `metadata` 的旧版兼容配置。

非 Node/TypeScript Agent 的接入说明见：

- `docs/how-to-integrate-non-node-agents.md`

当前推荐：

- 本地按需工具型 Agent：`stdio + on-demand`（如本地源码 `local-path` 或 npm 包）
- 由 Roll 按需拉起并管理生命周期的常驻 HTTP Agent：`streamable-http + core-managed`（如 `browser-use-agent`）
- 外部独立部署的常驻服务型 Agent：`streamable-http + external-managed`
- 非 Node 仓库若不想引入 `package.json`，继续使用 `SKILL.md metadata` 即可

## 双层标准架构

- **描述层**：Agent Skills 标准（SKILL.md frontmatter + body）— 告诉指挥官"我是谁、我会什么"
- **运行时层**：MCP 协议 — 指挥官实际调用子 Agent（stdio 本地子进程 / Streamable HTTP 服务）
- **Runtime Manifest**：`package.json#rollAgent` — 告诉指挥官"怎么启动我、怎么连接我"

## Core 模块

- `cli/` — 命令定义 + 终端 UI 工具（citty/ink/chalk/ora/cli-table3）
- `auth/` — ChatGPT 等订阅账号的 OAuth 登录、凭证存储与跨进程续期锁
- `execution-environment/` — 宿主运行环境探测（独立发行版 vs npm 全局）、私有 Node/命令路径解析与自更新目标校验
- `registry/` — SKILL.md 解析（gray-matter）、Agent 发现、注册持久化（~/.roll-agent/）与进程使用租约
- `router/` — 声明式路由 + LLM 智能路由
- `mcp/` — MCP Client 连接池（stdio/HTTP 传输）、Sampling 处理
- `llm/` — AI SDK Provider 接线、OpenAI Responses/ChatGPT 适配与统一模型调用
- `config/` — roll.config.yaml 加载、Zod 校验、breaking schema migration 检测
- `runtime-host/` — 动态加载 `@roll-agent/runtime`，把 config/registry/MCP 依赖注入 Runtime
- `scheduler-host/` — daemon、exec 子进程、进程树探活、用户服务与 admission lock
- `companion-host/` — Companion daemon、Relay 与本机 Runtime bridge
- `skills/` — Skill 发现、优先级、渐进式加载与告警
- `tool-runtime/` — 声明式 Tool 调用、preflight 与参数提取
- `ui/`、`packages/core/ui/` — 配置台服务端接线与 React 前端

## Runtime / Protocol ownership

Core/Runtime 拆分的目标是让 Runtime 可由不同宿主独立嵌入和测试。Core 是 Roll 的产品与宿主接线层，
Runtime 是可复用的执行内核；新增功能必须继续保持这个边界。

**代码依赖方向：`Core → Runtime → Protocol / 第三方基础库`。** Runtime 的源码、类型、测试和包依赖
不得反向依赖 Core。需要宿主能力时，由 Runtime 定义中立契约，Core 实现并注入；Runtime 调用
注入的宿主接口不构成反向包依赖。

- **Runtime 行为与持久化**放在 `packages/runtime`：对话引擎、会话管理、工具执行桥接、ThreadStore、
  调度状态机与账本。
- **产品与宿主集成**放在 `packages/core`：CLI/UI、完整配置解析、账号/凭证、Provider 创建与协议适配、
  模型能力发现、Agent Registry、MCP 连接管理、守护进程/系统服务与进程身份校验。
- **进程内注入契约**由 Runtime 的 `host-contracts`、`tool-contracts`、`skills` 等公开出口提供。
  `ConversationEngine` 接收 `RuntimeSettings`、模型和 `AgentHost` 等依赖；Core 的
  `runtime-host/engine-factory.ts` 将 `RollConfig` 显式投影为执行设置。不得把完整配置、认证服务、
  Registry 或具体 MCP manager 重新传入 Runtime。
- **跨进程公开契约**放在 `packages/protocol`；Node/Electron 消费者优先使用
  `packages/client-node`，不要直接复刻 JSON-RPC payload。

新增功能按语义归属拆分：

| 变化 | 归属与接线 |
| --- | --- |
| 某个 Provider 的认证、能力或请求字段，如 ChatGPT Fast / `service_tier` | Core 校验并适配，通过现有模型与 `providerOptions` 注入 Runtime；不向 Runtime 添加供应商专用分支 |
| 通用的轮次执行、取消、预算、压缩、审批或持久化规则 | Runtime 实现；需要外部资源时定义宿主契约并由 Core 注入 |
| CLI/UI 偏好、配置发现与默认值 | Core 维护，再映射成 Runtime 所需的执行参数；`runtime.*` 配置前缀不决定代码包归属 |
| 宿主间共享的请求、响应和事件格式 | Protocol 定义，宿主通过公开客户端消费 |

参数透传不等于功能已经生效。Provider 功能需验证适配器最终发出的请求；通用执行规则需验证 Runtime
状态与实际副作用。修改边界时同步更新契约、Core 映射及调用方，并保留默认值等价、资源所有权与生命周期测试。
API 迁移与宿主约束见 [Runtime 宿主 API 迁移](../runtime-core-api-migration.md)，
依赖迁移依据见 [Core/Runtime 依赖迁移表](../core-runtime-dependency-migration.md)。

## SDK 公开 API

```typescript
import {
  defineAgent,
  defineTool,
  createAgentLogger,
  StructuredToolError,
  isStructuredToolError,
  TOOL_RESOURCE_ACCESS_MODES,
  TOOL_RESOURCE_HINT_KINDS,
} from "@roll-agent/sdk";
// 核心类型：AgentContext, ToolDefinition, AgentDefinition, AnyToolDefinition, ToolResourceHint, AppOutputContract
```

`AnyToolDefinition` 用于异构 tool 集合（类型擦除），`ToolDefinition<TInput, TOutput>` 保留泛型类型安全。
