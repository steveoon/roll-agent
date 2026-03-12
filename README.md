# 花卷 Agent (Roll)

轻量级 Agent 编排系统。指挥官 + MCP 协议 + 按需加载。

```
roll ask "帮我查看boss直聘上有多少未读消息"
```

## 核心思路

**指挥官（roll-core）** 提供 LLM 基座、Agent 发现/调度、CLI 交互。**子 Agent** 通过 [MCP 协议](https://modelcontextprotocol.io/) 接入，可以是任意语言实现的本地子进程或远程服务。

```
用户 ──CLI──→ roll-core（指挥官）
                ├── Agent Registry（SKILL.md 注册）
                ├── Router（声明式 / LLM 智能）
                ├── MCP Client Manager
                └── LLM Engine（AI SDK v6 多 Provider）
                       │
              ┌────────┴────────┐
         stdio 本地子进程    HTTP 远程服务
         (MCP Server)       (MCP Server)
```

### 双层标准

| 层 | 标准 | 作用 |
|----|------|------|
| 描述层 | [Agent Skills](https://agentskills.io/)（SKILL.md） | 告诉指挥官"我是谁、我能做什么" |
| 运行时层 | [MCP](https://modelcontextprotocol.io/) | 实际调用子 Agent 的通信协议 |

### Sampling：子 Agent 借用指挥官 LLM

子 Agent 不需要自己配置 API Key。通过 MCP Sampling 协议回调指挥官的 LLM Engine 完成推理，实现 LLM 与子 Agent 的完全解耦。

## 安装

### 环境要求

- Node.js >= 22.6.0
- pnpm >= 10

### 从源码安装

```bash
git clone https://github.com/steveoon/roll-agent.git
cd roll-agent
pnpm install
```

开发模式（零编译，Node.js Type Stripping 直接运行 .ts）：

```bash
pnpm dev -- --help                      # 查看帮助
pnpm dev -- agent list                  # 运行子命令
pnpm dev -- ask "帮我回复候选人"         # LLM 智能路由
```

### 全局安装（构建后）

```bash
pnpm build
cd packages/core
npm link
roll --help
```

## 快速开始

### 1. 初始化配置

```bash
pnpm dev -- config init
```

会在当前目录生成 `roll.config.yaml`：

```yaml
llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-20250514
  providers:
    anthropic:
      api-key: ${ANTHROPIC_API_KEY}

router:
  mode: declarative

agents:
  data-dir: ~/.roll-agent/agents
```

支持的 provider：`anthropic`、`openai`、`deepseek`、`qwen`。每个 provider 可配置 `base-url` 用于自定义 API 端点。

> [!IMPORTANT]
> `api-key: ${...}` 中的 `${...}` 是“环境变量名占位符”，不是 API Key 本身。
>
> - 正确：`api-key: ${ANTHROPIC_API_KEY}`
> - 错误：`api-key: ${sk-xxxx}`（这会被当作变量名 `sk-xxxx`，`roll doctor` 会提示 API key 未设置）
>
> 如果想直接写死 key（不推荐），请写成：`api-key: sk-xxxx`（不要带 `${}`）。

### 2. 注册 Agent

```bash
# 本地路径
pnpm dev -- agent add ./agents/boss-reply

# Git URL
pnpm dev -- agent add https://github.com/someone/my-agent.git
```

### 3. 调用 Agent

```bash
# 声明式调用（明确指定 Agent + Tool）
pnpm dev -- run boss-reply-agent get_unread --limit 10

# LLM 智能路由（自然语言，自动选择 Agent + Tool）
pnpm dev -- ask "帮我查看未读消息"
```

## CLI 命令参考

```
roll agent add <path|url>       注册 Agent（解析 SKILL.md + 安装依赖）
roll agent remove <name>        移除 Agent
roll agent list                 列出所有已注册 Agent
roll agent start <name>         探测 Agent 可连接性（stdio 无需手动启动）
roll agent stop <name>          提示手动停止外部服务（stdio 无需手动停止）
roll agent info <name>          查看 Agent 详情（SKILL.md + tools）
roll agent health               健康检查（stdio 按需模式 / streamable-http 可达性）

roll run <agent> <tool> [args]  声明式调用（--key value 传参）
roll ask "<message>"            LLM 智能路由

roll config init                交互式初始化配置
roll config get [key]           查看配置（支持点号路径如 llm.defaultModel）
roll config set <key> <value>   修改配置

roll doctor                     诊断系统状态（Node.js / 配置 / Provider / Agent）
```

说明：`--json` 为子命令级参数（在支持的命令上可用）；全局 `--verbose` / `--config <path>`
当前为 planned，尚未统一透传到所有子命令。

## 开发子 Agent

### 方式 A：使用 SDK（Node.js / TypeScript）

```typescript
import { defineAgent, defineTool } from "@roll-agent/sdk";
import { z } from "zod";

const greet = defineTool({
  name: "greet",
  description: "向用户打招呼",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  execute: async (input) => {
    return { message: `你好，${input.name}！` };
  },
});

const agent = defineAgent({ name: "greeting-agent", tools: [greet] });
agent.listen(); // 启动 MCP Server（stdio 模式）
```

配套 SKILL.md：

```markdown
---
name: greeting-agent
description: 打招呼 Agent
metadata:
  roll-transport: stdio
  roll-command: node --experimental-strip-types src/index.ts
---

## Tools

- `greet` - 向用户打招呼
```

### 方式 B：任意语言（实现 MCP Server）

任何语言的 MCP Server 都可以接入（Python/Go/Rust/Java 均有官方 SDK），只需在 SKILL.md 中声明传输方式：

```markdown
---
name: wechat-agent
description: 微信自动回复
metadata:
  roll-transport: streamable-http
  roll-endpoint: http://localhost:8100/mcp
---
```

```bash
roll agent add ./wechat-agent
roll run wechat-agent send_message --userId xxx --content "你好"
```

## 项目结构

```
packages/
  core/       指挥官：CLI + Registry + Router + MCP Client + LLM Engine
  sdk/        子 Agent SDK：defineAgent() + defineTool()
agents/
  boss-reply/ 示例 Agent（BOSS直聘回复）
```

## 开发

```bash
pnpm dev                          # 运行 CLI
pnpm build                        # tsc 构建所有包
pnpm typecheck                    # 类型检查
pnpm test                         # 运行测试
pnpm lint                         # ESLint
pnpm format                       # Prettier
```

单包操作：

```bash
pnpm --filter @roll-agent/core typecheck
pnpm --filter @roll-agent/sdk build
node --experimental-strip-types --test packages/core/src/config/schema.test.ts
```

## 发布

### 前置检查

```bash
pnpm typecheck && pnpm lint && pnpm test     # 三件套必须全过
pnpm build                                    # 确认构建产物正常
```

### 发布到 npm

推荐方式：通过 GitHub Actions 自动发布（push 到 `main` 或手动触发 `Release` workflow）。

- 默认使用 npm Trusted Publishing（OIDC，推荐，无需 `NPM_TOKEN`）
- 需要先在 npm 为 `@roll-agent/sdk` 和 `@roll-agent/core` 配置 Trusted Publisher（GitHub repo + workflow）
- workflow 内已启用 `id-token: write`，并固定 npm 版本满足 Trusted Publishing 要求
- workflow 会执行质量检查，并仅发布 npm 上尚不存在的新版本

本地可先 dry-run：

```bash
pnpm release:dry-run -- --skip-checks --no-registry-check
```

手动发布（保留）：

```bash
# 1. 更新版本号
cd packages/sdk
npm version patch   # 或 minor / major
cd ../core
npm version patch

# 2. 构建
cd ../..
pnpm build

# 3. 发布（需要 npm 登录 + @roll-agent 组织权限，先 SDK 再 core）
cd packages/sdk
npm publish --access public
cd ../core
npm publish --access public

# 4. 提交版本号变更 + 打 tag
cd ../..
git add -A && git commit -m "chore: release v$(node -p "require('./packages/core/package.json').version")"
git tag v$(node -p "require('./packages/core/package.json').version")
git push && git push --tags
```

发布后用户即可全局安装：

```bash
npm install -g @roll-agent/core
roll --help
```

## 技术栈

| 领域 | 选型 |
|------|------|
| 语言 | TypeScript 5 strict（零 any） |
| 运行时 | Node.js 22.6+（原生 Type Stripping） |
| CLI | citty（类型安全命令定义） |
| MCP | @modelcontextprotocol/sdk |
| LLM | AI SDK v6 + Anthropic/OpenAI/DeepSeek/Qwen |
| 配置 | YAML + Zod 校验 |
| 测试 | node:test + node:assert（零外部依赖） |
| 构建 | tsc（输出 .js + .d.ts） |
| 包管理 | pnpm workspace |

## License

MIT
