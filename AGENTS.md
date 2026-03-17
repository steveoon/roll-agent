# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**花卷 Agent (Roll)** — 轻量级 Agent 编排系统。CLI 命令：`roll`，npm 组织：`@roll-agent`。

指挥官（roll-core）提供 LLM 基座 + Agent 发现/调度 + CLI 交互，子 Agent 通过 MCP 协议接入。

## Development Commands

```bash
# 开发（零编译，Node.js Type Stripping 直接运行 .ts）
pnpm dev                          # 运行 CLI 入口
pnpm dev -- agent list            # 运行子命令

# 构建与检查
pnpm build                        # tsc 构建所有包（输出 dist/）
pnpm typecheck                    # tsc --noEmit 类型检查
pnpm lint                         # ESLint 9 + neostandard
pnpm format                       # Prettier 格式化
pnpm format:check                 # 检查格式

# 测试（node:test + node:assert/strict）
pnpm test                         # 运行所有包的测试
node --experimental-strip-types --test packages/core/src/config/schema.test.ts  # 单个测试文件

# 单包操作
pnpm --filter @roll-agent/core typecheck
pnpm --filter @roll-agent/sdk build
pnpm --filter boss-reply-agent dev
```

**环境要求**：Node.js ≥22.6.0，pnpm 10+

## Architecture

### Monorepo 结构（pnpm workspace）

| 包 | 作用 |
|------|------|
| `packages/core` | 指挥官：CLI (citty) + Agent Registry + Router + MCP Client + LLM Engine |
| `packages/sdk` | 子 Agent 开发 SDK：`defineAgent()` + `defineTool()` |
| `agents/boss-reply` | 示例 Agent（BOSS直聘回复，3 个 tool） |

### 双层标准架构

- **描述层**：Agent Skills 标准（SKILL.md frontmatter）— 告诉指挥官"我是谁"
- **运行时层**：MCP 协议 — 指挥官实际调用子 Agent（stdio 本地子进程 / Streamable HTTP 远程服务）

### CLI 命令树（citty，懒加载子命令）

```
roll agent add|install|remove|list|start|stop|info   Agent 管理
roll run <agent> <tool> [args]               声明式调用
roll ask "<message>"                         LLM 智能路由
roll config set|get|init                     配置管理
roll doctor                                  系统诊断
```

### Core 模块

- `cli/` — 命令定义 + 终端 UI 工具（chalk/ora/cli-table3）
- `registry/` — SKILL.md 解析（gray-matter）、Agent 发现、注册持久化（~/.roll-agent/）
- `router/` — 声明式路由 + LLM 智能路由
- `mcp/` — MCP Client 连接池（stdio/HTTP 传输）、Sampling 处理
- `llm/` — 统一 LLM 引擎（AI SDK v6 + 多 Provider）
- `config/` — roll.config.yaml 加载与 Zod 校验

### SDK 公开 API

```typescript
import { defineAgent, defineTool } from "@roll-agent/sdk";
// 类型：AgentContext, ToolDefinition, AgentDefinition, AnyToolDefinition
```

`AnyToolDefinition` 用于异构 tool 集合（类型擦除），`ToolDefinition<TInput, TOutput>` 保留泛型类型安全。

## TypeScript 约束

### Type Stripping 兼容（erasableSyntaxOnly）

- 使用 `import type` 分离类型导入（`verbatimModuleSyntax`）
- 禁止 `enum`、`namespace`、构造函数参数属性 — 用 `as const` 对象替代
- 导入路径**必须**使用 `.ts` 扩展名（`allowImportingTsExtensions`）
- 构建时 `rewriteRelativeImportExtensions` 自动将 `.ts` 重写为 `.js`

### 严格模式

- 零 `any` — 使用 `unknown` + 类型收窄
- `exactOptionalPropertyTypes`、`noUncheckedIndexedAccess` 均开启
- 所有 strict 标志启用

### 类型设计规范（遵循 `/typescript-magician`）

定义或修改类型时**必须主动使用** `/typescript-magician` skill 审查，确保：

- 用 `as const` + `typeof` 从运行时值派生类型，避免手动维护重复的 string literal union
- Zod schema 作为单一数据源，接口类型通过 `z.infer<typeof schema>` 或索引访问（如 `Config["router"]["mode"]`）派生
- 泛型约束恰到好处（`extends` 只约束实际使用的属性），避免过度约束或遗漏约束
- 异构集合使用类型擦除基础接口（如 `AnyToolDefinition`），具体泛型接口 extends 基础接口
- 语义性强的值使用 brand type（如 `Confidence`），附带运行时校验工厂函数
- 用 type predicate（`x is T`）替代 `as` 类型断言做收窄
- 用 `Record` mapping / handler pattern 替代 `if-else` / `switch`

### tsconfig 策略

- `tsconfig.base.json` — 开发/IDE 用（noEmit）
- `tsconfig.build.json` — 发布构建用（输出 .js + .d.ts + .map）
- 各包 `tsconfig.json` extends base，`tsconfig.build.json` extends root build

## 关键架构洞察

### Sampling Handler（子 Agent 借用指挥官 LLM）

子 Agent 通过 MCP Sampling 协议回调指挥官的 LLM。流程：
1. 指挥官在 `McpClientManager` 连接子 Agent 时注册 `CreateMessageRequestSchema` handler
2. 子 Agent 调用 `server.createMessage()` → MCP 协议转发到指挥官
3. 指挥官的 `sampling-handler.ts` 用 AI SDK `generateText()` 完成推理，返回结果

这使子 Agent 无需自带 LLM 配置，解耦了 LLM 提供商与子 Agent。

### SKILL.md body 参与 LLM 路由

SKILL.md 的 frontmatter 用于注册元数据，**body 正文内容**会被 `llm-router.ts` 拼入 Agent 能力描述，供 LLM 理解 Agent 具体能做什么。编写 SKILL.md 时需注意 body 质量。

### 日志输出约定

- **stdout** — 仅输出数据（供管道和 `--json` 结构化输出）
- **stderr** — 所有日志、状态信息、彩色输出（chalk/ora）

这是为了避免 stdio 模式下日志干扰 MCP 协议通信。SDK 的 `AgentLogger` 也遵循此规则。

### 配置文件发现链

`loadConfig()` 按以下优先级查找配置：
1. `--config` 显式路径
2. 从 `cwd` 向上逐级查找 `roll.config.yaml` / `roll.config.yml`
3. 回退到内置默认配置

加载管线：YAML 解析 → kebab-case→camelCase → `${ENV_VAR}` 替换 → 深度合并默认值 → Zod 校验 → `~/` 路径展开。

### `roll ask` 两阶段调用与 Tool Schema 语义不可篡改原则

`roll ask` 将自然语言转为 tool 调用，分两阶段：

1. **路由阶段**（`llm-router.ts`）— LLM 只选择 agent + tool，不提取参数
2. **提参阶段**（`extraction-schema.ts` / `argument-extractor.ts`）— LLM 按 tool `inputSchema` 提取参数，preflight 校验后再调用

**核心原则：extraction schema 不得改写原始 tool `inputSchema` 的类型语义。**

- 原始 `inputSchema` 是 MCP tool 的契约，preflight 和 `callTool()` 始终以它为准
- extraction schema 只做“适配 LLM structured output”的变换，例如 `additionalProperties: false`、provider 兼容的 `required` 处理
- **不可提取的字段必须剔除，不得降级类型**。例如 `z.record()` 这类开放 object 无法从自然语言可靠提取，应从 extraction schema 中移除，让 preflight 返回 `needs_input` / `requires_explicit_input`
- 这类参数由 `roll run --input-json` 或上层编排器显式提供

**禁止的反模式：** 为兼容某个 provider 的 structured output 限制，把合法 tool 输入的 schema 类型从 `object` 改成 `string`。这会导致 extraction 产出的类型与 preflight 期望的类型前后不一致，让一整类合法 MCP tool 在 `roll ask` 下不可用。

### CLI 懒加载

citty 子命令通过动态 `import()` 懒加载，CLI 启动不会加载所有命令模块。

#### CLI 懒加载发布坑（必读）

- 历史问题：全局安装后执行 `roll agent health` 报错 `Cannot find module .../agent-health.ts`
- 本质原因：`tsc` 的 `rewriteRelativeImportExtensions` 对动态 `import()` 的改写并不总是可靠，某些懒加载写法会在 `dist` 中残留 `.ts` specifier，运行时（只存在 `.js`）直接崩溃
- 编码规则：不要在懒加载点直接写死 `import("./xxx.ts")`；统一用 helper 根据 `import.meta.url` 推断当前后缀（`.ts/.js`），再拼接并 `import()`
- 发布前校验：必须执行 `pnpm --filter @roll-agent/core build && node packages/core/dist/cli/index.js agent health`，无已注册 agent 时输出“暂无已注册 Agent”即通过

## Workspace 依赖解析

SDK 的 `exports` 在开发时指向 `./src/index.ts`（直接引用源码），发布时通过 `publishConfig.exports` 指向 `./dist/`。这样 workspace 内其他包（如 boss-reply-agent）无需先构建 SDK 即可获得类型。

## Configuration

`roll.config.yaml` — YAML 格式，支持 `${ENV_VAR}` 环境变量引用。Zod schema 定义在 `packages/core/src/config/schema.ts`。

## Testing

使用 Node.js 内置 `node:test` + `node:assert/strict`，零外部测试依赖。测试文件与源码同目录，命名 `*.test.ts`。

## Code Style

- ESLint 9 flat config + neostandard（`noStyle: true` 避免与 Prettier 冲突）
- Prettier：双引号、分号、尾逗号、100 字符行宽
- ESM Only：`"type": "module"`，使用 `import.meta.dirname` 替代 `__dirname`
