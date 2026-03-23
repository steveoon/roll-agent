# 花卷 Agent (Roll) — 项目计划书

> 轻量级、按需加载的 Agent 编排系统
>
> CLI 命令：`roll` | npm 组织：`@roll-agent`

## 1. 项目背景

### 1.1 现状问题

现有 Next.js 招聘助手平台（ai-sdk-computer-use）将前后端代码、Agent 逻辑、Tool 定义、LLM 集成全部混合在一个项目中。随着业务复杂度增长，存在以下问题：

- **关注点耦合**：LLM 基座、Agent 编排、业务工具、前端 UI 混杂在同一代码库
- **扩展困难**：新增 Agent 能力需要修改主项目代码，无法独立开发和部署
- **协作壁垒**：第三方开发者无法在不了解整个项目的情况下贡献 Agent 能力

### 1.2 解决方案

构建 **花卷 Agent (Roll)**——一个轻量级 Agent 编排框架，将"指挥官"与"执行者"解耦：

- **指挥官（roll-core）**：提供 LLM 基座 + Agent 发现/调度 + CLI 交互
- **执行者（子 Agent）**：独立的能力服务，通过标准协议注册和被调用
- **按需加载**：Agent 在注册时安装依赖，运行时只做加载和调用

## 2. 核心设计原则

### 2.1 双层标准架构

| 层级 | 作用 | 采用标准 | 原因 |
|------|------|----------|------|
| **描述层** | 告诉指挥官"我是谁、我能做什么" | [Agent Skills](https://agentskills.io/) (SKILL.md) | Anthropic 主导的开放标准，Claude Code/Cursor/VS Code/Gemini CLI 等 30+ 产品已采用 |
| **运行时层** | 指挥官实际调用子 Agent 的协议 | [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) | 行业事实标准，8 种语言官方 SDK，支持 stdio/Streamable HTTP 两种传输模式 |

**为什么不自定义运行时协议（如 manifest.json + JSON-RPC/IPC）？**

在设计过程中我们评估了自定义方案，发现以下致命限制：

1. **语言锁定**：Node.js IPC 是专属机制，Python/Go/Rust Agent 无法接入
2. **生命周期假设错误**：并非所有 Agent 都是"按需启动的子进程"，很多是已运行的长驻服务
3. **零生态价值**：自定义协议的学习成本纯浪费，集成商无复用动力
4. **重复造轮子**：MCP 已解决 tool schema 定义、传输协议、能力协商等全部问题

### 2.2 架构灵感来源

**OpenClaw（参考其精髓，不照搬复杂度）：**

- ✅ Gateway 控制面 + Agent 执行面分离 → 简化为 roll-core + MCP Server
- ✅ Workspace 级别的 Agent 配置管理 → 简化为 `roll.config.yaml`
- ✅ 声明式路由（channel → agent 映射）→ `roll run <agent> <tool>`
- ✅ Agent 间通信（sessions_send）→ 指挥官作为中枢协调
- ✅ 三级 Skill 体系（bundled/managed/workspace）→ 当前落地为 local-path / installed / remote 三种交付形态
- ❌ 不需要 20+ 消息平台适配器（垂直场景）
- ❌ 不需要设备节点（Node pairing）
- ❌ 不需要 WebSocket 全双工控制面（CLI 足够）

### 2.3 设计约束

- **Node.js + TypeScript**：核心框架用 TypeScript 严格模式，零 `any`
- **子 Agent 语言无关**：任何实现了 MCP 协议的服务都可以接入
- **CLI-first**：暂不提供 GUI，所有交互通过命令行
- **最小依赖**：核心不捆绑业务逻辑，保持 "Nano"

## 3. 系统架构

### 3.1 整体流程

```
用户 CLI 输入
    │
    ├─ roll run boss-reply get_unread        ← 声明式路由
    │
    ├─ roll ask "上海肯德基还招人吗?"       ← 单轮 LLM 路由
    │
    └─ roll chat "帮我处理这批候选人"         ← 会话式统一入口（规划中）
    │
    ▼
┌──────────────────────────────────────────┐
│  roll-core（指挥官）                       │
│                                          │
│  ┌─────────────┐  ┌──────────────────┐   │
│  │ Agent       │  │ Router           │   │
│  │ Registry    │  │ ├ declarative    │   │
│  │ (SKILL.md)  │  │ └ llm-powered   │   │
│  └──────┬──────┘  └────────┬─────────┘   │
│         │                  │             │
│  ┌──────▼──────────────────▼─────────┐   │
│  │ MCP Client Manager               │   │
│  │ (连接池、生命周期管理)              │   │
│  └──────┬────────────────┬───────────┘   │
│         │                │               │
│  ┌──────▼──────┐  ┌──────▼──────┐        │
│  │ LLM Engine  │  │ CLI         │        │
│  │ (基座)      │  │ (Commander) │        │
│  └─────────────┘  └─────────────┘        │
└─────────┬────────────────┬───────────────┘
          │ stdio          │ Streamable HTTP
          ▼                ▼
    ┌───────────┐    ┌───────────────┐
    │ 本地 Agent │    │ 远程 Agent     │
    │ (子进程)   │    │ (已运行服务)    │
    │ MCP Server │    │ MCP Server    │
    └───────────┘    └───────────────┘
```

### 3.2 子 Agent 接入模式

**模式 A：本地子进程（stdio 传输）**

适用于轻量 Agent，由 roll-core 在调用时按需启动并在调用结束后释放（不作为后台 daemon）：

```
roll-core  ──fork/spawn──→  子进程
           ←──stdio────→   MCP Server (JSON-RPC over stdin/stdout)
```

**模式 B：远程/长驻服务（Streamable HTTP 传输）**

适用于已运行的复杂服务，独立管理生命周期：

```
roll-core  ──HTTP──→  http://localhost:8100/mcp
                      MCP Server (任意语言/任意部署方式)
```

### 3.3 子 Agent 如何使用指挥官的 LLM 能力

子 Agent 可能需要 LLM 来做决策（如生成候选人回复），通过 MCP 的 **Sampling** 机制实现：

```
子 Agent                         roll-core
   │                                │
   │── sampling/createMessage ──→   │  （请求 LLM 推理）
   │                                │── 调用 LLM Engine
   │                                │← LLM 响应
   │←── sampling response ─────     │
   │                                │
```

子 Agent 不需要自己配置 API Key 或 LLM Provider，统一由指挥官的 LLM 基座提供。

## 4. 项目结构

```
nano-agent/
├── packages/
│   ├── core/                        # 指挥官核心
│   │   ├── src/
│   │   │   ├── cli/                 # CLI 命令定义
│   │   │   │   ├── index.ts         # 入口，注册所有命令
│   │   │   │   ├── commands/
│   │   │   │   │   ├── run.ts       # roll run <agent> <tool>
│   │   │   │   │   ├── ask.ts       # roll ask "自然语言"
│   │   │   │   │   ├── chat.ts      # roll chat [message]
│   │   │   │   │   ├── agent.ts     # roll agent add/remove/list/start/stop
│   │   │   │   │   ├── config.ts    # roll config set/get
│   │   │   │   │   └── doctor.ts    # roll doctor（诊断）
│   │   │   │   └── utils/
│   │   │   │       ├── output.ts    # 终端输出格式化（表格、颜色、spinner）
│   │   │   │       └── prompt.ts    # 交互式输入
│   │   │   │
│   │   │   ├── registry/            # Agent 注册表
│   │   │   │   ├── registry.ts      # AgentRegistry 核心类
│   │   │   │   ├── discovery.ts     # SKILL.md 解析与 Agent 发现
│   │   │   │   ├── lifecycle.ts     # Agent 生命周期管理（start/stop/health）
│   │   │   │   └── store.ts         # 注册信息持久化（~/.roll-agent/）
│   │   │   │
│   │   │   ├── router/              # 路由层
│   │   │   │   ├── declarative.ts   # 声明式路由（name → agent 直接映射）
│   │   │   │   ├── llm-router.ts    # LLM 智能路由（意图识别 → agent 选择）
│   │   │   │   └── index.ts         # 路由策略选择
│   │   │   │
│   │   │   ├── mcp/                 # MCP 客户端管理
│   │   │   │   ├── client-manager.ts # MCP 连接池（stdio/HTTP）
│   │   │   │   ├── stdio-transport.ts
│   │   │   │   ├── http-transport.ts
│   │   │   │   └── sampling-handler.ts # 处理子 Agent 的 LLM 请求
│   │   │   │
│   │   │   ├── llm/                 # LLM 基座
│   │   │   │   ├── engine.ts        # 统一 LLM 调用接口
│   │   │   │   ├── providers/       # Provider 适配器
│   │   │   │   │   ├── anthropic.ts
│   │   │   │   │   ├── openai.ts
│   │   │   │   │   └── qwen.ts
│   │   │   │   └── model-registry.ts # 模型注册与选择
│   │   │   │
│   │   │   ├── config/              # 全局配置
│   │   │   │   ├── schema.ts        # 配置 Zod schema
│   │   │   │   ├── loader.ts        # 配置文件加载
│   │   │   │   └── defaults.ts      # 默认配置
│   │   │   │
│   │   │   └── types/               # 共享类型定义
│   │   │       ├── agent.ts         # Agent 相关类型
│   │   │       ├── router.ts        # 路由相关类型
│   │   │       ├── mcp.ts           # MCP 相关类型
│   │   │       └── config.ts        # 配置相关类型
│   │   │
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── sdk/                         # 子 Agent 开发 SDK（Node.js）
│       ├── src/
│       │   ├── define-agent.ts      # defineAgent() 工厂函数
│       │   ├── define-tool.ts       # defineTool() 类型安全的 tool 定义
│       │   ├── context.ts           # AgentContext（LLM、Logger 等能力）
│       │   └── types/
│       │       └── index.ts         # SDK 公开类型
│       ├── package.json
│       └── tsconfig.json
│
├── agents/                          # 示例/内置 Agent
│   └── boss-reply/                  # BOSS直聘回复 Agent（示例）
│       ├── SKILL.md
│       ├── package.json
│       └── src/
│           ├── index.ts
│           └── tools/
│               ├── get-unread.ts
│               ├── reply-candidate.ts
│               └── batch-reply.ts
│
├── roll.config.yaml                 # 全局配置文件（示例）
├── package.json                     # monorepo 根配置
├── pnpm-workspace.yaml
├── tsconfig.base.json               # 共享 TypeScript 基础配置（开发用，noEmit）
├── tsconfig.build.json              # 共享构建配置（发布用，输出 .js + .d.ts）
├── eslint.config.js                 # ESLint 9 flat config（neostandard）
├── .prettierrc                      # Prettier 配置
├── .gitignore
└── PROJECT_PLAN.md
```

## 5. CLI 设计

### 5.1 命令总览

```bash
roll — 花卷 Agent，轻量级 Agent 编排系统

Commands:
  roll agent add <path|url>       注册本地目录或 Git Agent（安装依赖）
  roll agent add --remote <url>   注册远程 streamable-http Agent
  roll agent install <package>    安装并注册已编译 Agent 包
  roll agent remove <name>        移除一个 Agent
  roll agent list                 列出所有已注册 Agent
  roll agent start <name>         探测 Agent 可连接性（stdio 无需手动启动）
  roll agent stop <name>          提示手动停止外部服务（stdio 无需手动停止）
  roll agent info <name>          查看 Agent 详情（SKILL.md + tools）

  roll run <agent> <tool> [args]  声明式调用 Agent 的指定 tool
  roll ask "<message>"            LLM 智能路由，自动选择 Agent 和 tool
  roll chat [message]             Experimental：未来会话式统一入口（当前仅提供骨架）

  roll config set <key> <value>   设置全局配置
  roll config get [key]           查看配置
  roll config init                交互式初始化配置

  roll doctor                     诊断系统状态

Options:
  --json                          JSON 格式输出（在支持的子命令上可用）
  --verbose, -v                   （planned）全局详细输出
  --config <path>                 （planned）全局指定配置文件
  --help, -h                      帮助信息
  --version                       版本号
```

### 5.2 使用示例

```bash
# 初始化
roll config init
# → 交互式配置 LLM provider、API key 等

# 注册本地 Agent
roll agent add ./agents/boss-reply
# → ✓ 解析 SKILL.md
# → ✓ 安装依赖 (npm install)
# → ✓ 构建 (npm run build)
# → ✓ 注册完成：boss-reply-agent (3 tools)

# 注册远程 Agent
roll agent add https://github.com/someone/wechat-agent.git
# → ✓ 克隆仓库
# → ✓ 解析 SKILL.md (transport: streamable-http)
# → ✓ 注册完成：wechat-agent (remote: http://localhost:8100/mcp)

# 查看已注册 Agent
roll agent list
# ┌──────────────────┬────────┬───────────┬───────┐
# │ Name             │ Status │ Transport │ Tools │
# ├──────────────────┼────────┼───────────┼───────┤
# │ boss-reply-agent │ idle   │ stdio     │ 3     │
# │ wechat-agent     │ online │ http      │ 3     │
# └──────────────────┴────────┴───────────┴───────┘

# 声明式调用
roll run boss-reply-agent get_unread --limit 10
# → [调用 MCP tool] boss-reply-agent.get_unread({limit: 10})
# → 返回 5 条未读消息...

roll run boss-reply-agent reply_candidate --candidateId abc123
# → [调用 LLM 生成回复]
# → [发送回复] "您好，感谢您对该职位的关注..."
# → ✓ 回复成功

# LLM 智能路由
roll ask "帮我查看boss直聘上有多少未读消息"
# → [路由] 匹配 Agent: boss-reply-agent
# → [路由] 匹配 Tool: get_unread
# → 当前有 5 条未读消息

roll ask "自动回复所有boss上的候选人"
# → [路由] 匹配 Agent: boss-reply-agent
# → [路由] 匹配 Tool: batch_reply
# → [确认] 即将批量回复 5 条消息，是否继续？(Y/n)
# → 处理中... 5/5
# → ✓ 全部回复完成
```

### 5.3 配置文件

```yaml
# roll.config.yaml
llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-20250514

  providers:
    anthropic:
      api-key: ${ANTHROPIC_API_KEY}   # 支持环境变量引用
    qwen:
      api-key: ${DASHSCOPE_API_KEY}

ask:
  llm-model: qwen-plus                # `roll ask` 使用的模型（默认回退到 llm.default-model）
  confirm-threshold: 0.5             # 低于阈值时返回 needs_confirmation

agents:
  data-dir: ~/.roll-agent/agents       # Agent 注册数据存储位置
```

## 6. 核心类型设计

### 6.1 Agent 描述层类型（SKILL.md 解析结果）

```typescript
/** SKILL.md frontmatter 解析结果 */
interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** SKILL.md metadata 中 Roll 扩展字段 */
interface RollSkillMetadata {
  readonly "roll-transport"?: "stdio" | "streamable-http";
  readonly "roll-command"?: string;         // stdio 模式启动命令
  readonly "roll-endpoint"?: string;        // HTTP 模式端点地址
  readonly "roll-health-check"?: string;    // 健康检查端点
}
```

### 6.2 Agent 运行时类型

```typescript
/** Agent 传输模式 */
type AgentTransport =
  | { readonly type: "stdio"; readonly command: string; readonly args?: readonly string[] }
  | { readonly type: "streamable-http"; readonly endpoint: string };

/** 已注册的 Agent 完整信息 */
interface RegisteredAgent {
  readonly skill: AgentSkill;
  readonly transport: AgentTransport;
  readonly installPath: string;
  readonly registeredAt: string;          // ISO 8601
  readonly status: AgentStatus;
}

type AgentStatus = "idle" | "starting" | "online" | "error" | "stopped";

/** MCP Tool Schema（来自 MCP 协议） */
interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
```

### 6.3 路由类型

```typescript
/** LLM 路由决策结果 */
interface RouteDecision {
  readonly agentName: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly confidence: number;            // 0-1，低于阈值时请求用户确认
}
```

### 6.4 配置类型

```typescript
interface RollConfig {
  readonly llm: LLMConfig;
  readonly ask: AskConfig;
  readonly agents: AgentsConfig;
}

interface LLMConfig {
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
}

interface ProviderConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

interface AskConfig {
  readonly llmModel?: string;
  readonly confirmThreshold?: number;     // LLM 路由置信度确认阈值
}

interface AgentsConfig {
  readonly dataDir: string;
}
```

## 7. 技术栈

### 7.1 依赖选型

| 类别 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript 5.x (strict mode) | 零 `any`，完整类型推断 |
| 运行时 | Node.js 22.6+（原生 Type Stripping） | 开发期 `node src/index.ts` 直接运行，无需编译步骤 |
| 包管理 | pnpm workspace | monorepo 管理，高效依赖提升 |
| CLI 框架 | [citty](https://github.com/unjs/citty) 或 [clipanion](https://github.com/arcanis/clipanion) | 类型安全的命令定义 |
| Schema 校验 | Zod v4 | 配置校验、LLM structured output |
| MCP SDK | `@modelcontextprotocol/sdk` | 官方 TypeScript MCP 客户端 |
| LLM 集成 | AI SDK v6 (`ai` + provider packages) | 统一多 Provider 接口，流式支持 |
| 配置格式 | YAML (`yaml` package) | 人类可读，支持环境变量引用 |
| 终端 UI | `chalk` + `ora` + `cli-table3` | 彩色输出、加载动画、表格 |
| 测试 | `node:test` + `node:assert` | Node.js 内置测试框架，零外部依赖，符合 Nano 理念 |
| 构建 | `tsc`（TypeScript Compiler） | 发布构建用 `tsc -p tsconfig.build.json`，生成 `.js` + `.d.ts`，无需打包工具 |
| 代码规范 | ESLint 9 + neostandard | 行业标准 flat config，内置 TypeScript 支持 |
| 格式化 | Prettier | 统一代码格式，neostandard 配合 `noStyle: true` 避免规则冲突 |
| SKILL.md 解析 | `gray-matter` | YAML frontmatter 解析 |

### 7.2 开发规范要点

- **Type Stripping 兼容**：使用 `import type` 分离类型导入、`as const` 替代 enum、禁止 namespace 和构造函数参数属性、导入路径使用 `.ts` 扩展名
- **ESM Only**：`"type": "module"`，使用 `import.meta.dirname` 替代 `__dirname`
- **开发工作流**：`node src/cli/index.ts` 直接运行（零编译），`tsc --noEmit` 单独做类型检查
- **发布构建**：`tsc -p tsconfig.build.json` 输出 `.js` + `.d.ts` 到 `dist/`，`rewriteRelativeImportExtensions` 自动将 `.ts` 重写为 `.js`

> **实现时参考的 Skills：**
> - TypeScript 配置与 Type Stripping 约束 → `/node-best-practices`（尤其 `rules/typescript.md`、`rules/modules.md`）
> - ESLint 9 flat config 与 neostandard 配置 → `/linting-neostandard-eslint9`
> - TypeScript 严格类型设计 → `/typescript-magician`

## 8. 集成商接入指南（子 Agent 开发）

### 8.1 使用 Roll SDK（Node.js 开发者）

```typescript
// my-agent/src/index.ts
import { defineAgent, defineTool } from "@roll-agent/sdk";
import { z } from "zod";

const sendMessage = defineTool({
  name: "send_message",
  description: "发送消息给指定用户",
  input: z.object({
    userId: z.string(),
    content: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
    messageId: z.string(),
  }),
  execute: async (input, ctx) => {
    // ctx.llm — 指挥官 LLM 基座（通过 MCP Sampling）
    // ctx.logger — 结构化日志
    const result = await myService.send(input.userId, input.content);
    return { success: true, messageId: result.id };
  },
});

const agent = defineAgent({
  name: "my-agent",
  tools: [sendMessage],
});

agent.listen(); // 启动 MCP Server (stdio 模式)
```

### 8.2 不使用 SDK（任意语言开发者）

只需两步：

1. **用任意语言实现 MCP Server**（Python/Go/Rust/Java 均有官方 SDK）
2. **编写 SKILL.md** 并在 metadata 中声明传输方式

```python
# Python 示例
from mcp.server import FastMCP

mcp = FastMCP("wechat-agent")

@mcp.tool()
async def send_message(user_id: str, content: str) -> dict:
    """发送微信消息"""
    result = await wechat_api.send(user_id, content)
    return {"success": True, "message_id": result.id}

mcp.run(transport="streamable-http", port=8100)
```

```markdown
<!-- SKILL.md -->
---
name: wechat-agent
description: 微信自动回复。发送消息、查看未读、自动回复。
metadata:
  roll-transport: streamable-http
  roll-endpoint: http://localhost:8100/mcp
---
```

```bash
roll agent add ./wechat-agent   # 注册
roll run wechat-agent send_message --userId xxx --content "你好"
```

## 9. 实施路线

### Phase 1 — 最小闭环（核心链路跑通）

**目标**：一个 Agent 能通过 CLI 被注册、调用、返回结果

- [x] 项目脚手架搭建（monorepo、TypeScript 严格模式、CI 基础）
- [x] `roll.config.yaml` 配置加载与校验
- [x] `roll agent add <path>` — 本地目录注册
- [x] `roll agent install <package>` — 已编译 Agent 包安装与注册
- [x] `roll agent add --remote <url>` — 远程 streamable-http Agent 注册
- [x] `roll agent list` — 列出已注册 Agent
- [x] MCP Client Manager — stdio 传输模式
- [x] `roll run <agent> <tool>` — 声明式调用
- [x] LLM Engine 基础（单 Provider 接入，如 Anthropic）
- [x] `boss-reply-agent` 示例 Agent（1-2 个简单 tool）
- [x] `@roll-agent/sdk` 基础（defineAgent + defineTool + listen）

### Phase 2 — 智能路由 + 多传输

**目标**：支持 LLM 路由和远程 Agent

- [x] `roll ask` — LLM 智能路由
- [x] MCP Streamable HTTP 传输支持
- [x] MCP Sampling 处理（子 Agent 使用指挥官 LLM）
- [x] 多 LLM Provider 支持（Qwen、OpenAI）
- [x] Agent 生命周期语义收敛（stdio 按需启动/释放，streamable-http 外部管理）
- [x] `roll doctor` — 系统诊断
- [x] `roll agent add <git-url>` — 从 Git 仓库注册

### Phase 3 — 生产就绪

**目标**：健壮性、可观测性、开发体验

- [x] Agent 健康检查（stdio 按需模式 / streamable-http 可达性）
- [x] 结构化日志与错误追踪
- [x] `roll config init` 交互式配置向导
- [x] SDK 完善：context.logger、错误处理模式
- [ ] 完整测试覆盖（核心模块 80%+）
- [ ] npm 发布（`@roll-agent/core`、`@roll-agent/sdk`）
- [ ] 文档站（使用指南、集成商接入指南、API Reference）

## 10. 与现有项目的关系

花卷 Agent 是独立项目，与 ai-sdk-computer-use 的关系：

- **LLM 基座**：从 `lib/model-registry/` 提取核心逻辑，精简后迁入
- **Boss 回复能力**：从 `lib/tools/zhipin/` 提取为独立子 Agent
- **未来**：ai-sdk-computer-use 可作为花卷 Agent 的 Web UI 前端，通过 API 调用 roll-core

两个项目独立演进，roll-agent 不依赖 ai-sdk-computer-use 的任何代码。
