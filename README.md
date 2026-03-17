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

## 最近关键改进

- `roll ask` 现在是**两阶段调用**：先路由到 `agent + tool`，再按目标 tool 的真实 `inputSchema` 提取参数，不再让 LLM 自由发明参数名。
- `roll-core` 新增了 `tool-runtime` 适配层：统一做参数提取、preflight 校验、错误分类和用户提示。
- 路由结果已拆成 `RouteSelection` 与 `RouteDecision`：先选 tool，再补参数，CLI 和上层编排器都更容易复用这套状态机。
- `roll run` 已支持 `--input-json` / `--input-file`：适合显式传递复杂对象、开放对象和批量 payload。
- `smart-reply-agent` 的品牌数据同步已从“手工 push 数据”改成“从 Duliday pull 数据”，并升级为新的品牌数据模型：`meta + brands[] + stores[] + positions[]`。

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
# 本地目录（开发态）
pnpm dev -- agent add ./agents/boss-reply

# 已编译 npm 包（分发态）
pnpm dev -- agent install @roll-agent/smart-reply-agent

# Git URL
pnpm dev -- agent add https://github.com/someone/my-agent.git

# 远程 MCP 服务
pnpm dev -- agent add --remote https://example.com/mcp --name remote-agent --description "远程 Agent"
```

如果你安装的是 `smart-reply-agent` 这类需要独立环境变量的 Agent，推荐在 `roll.config.yaml` 中通过 `agents.env` 为它单独注入配置：

```yaml
agents:
  data-dir: ~/.roll-agent/agents
  env:
    smart-reply-agent:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      SMART_REPLY_PROXY_BASE_URL: ${SMART_REPLY_PROXY_BASE_URL}
      DULIDAY_TOKEN: ${DULIDAY_TOKEN}
      DULIDAY_BRAND_LIST_URL: ${DULIDAY_BRAND_LIST_URL}
      DULIDAY_JOB_LIST_URL: ${DULIDAY_JOB_LIST_URL}
```

这样 `roll-core` 在启动 `smart-reply-agent` 的 stdio 子进程时会自动注入这些变量，不需要用户手工在 shell 里 `export` 一大串值。

### 3. 调用 Agent

```bash
# 声明式调用（明确指定 Agent + Tool）
pnpm dev -- run boss-reply-agent get_unread --limit 10

# 显式传入结构化 JSON（适合 object / record / 复杂 payload）
pnpm dev -- run smart-reply-agent sync_brand_data \
  --input-json '{"cityName":"上海市","brandAlias":"肯德基"}'

# 或从文件读取完整 payload
pnpm dev -- run some-agent sync_config --input-file ./payload.json

# LLM 智能路由（自然语言，自动选择 Agent + Tool）
pnpm dev -- ask "帮我查看未读消息"
```

说明：

- `roll run` 现在同时支持 `--key value`、`--input-json`、`--input-file`
- `--input-json` / `--input-file` 适合传递复杂对象参数；命令行 `--key value` 更适合简单标量参数
- `roll ask` 适合“自然语言可以可靠映射到 tool 参数”的场景；如果某个必填字段是开放对象（如 `z.record()` / 任意 JSON payload），`ask` 会返回 `needs_input`，提示改用 `roll run --input-json` 或上层编排器显式提供
- `roll ask` 不会篡改原始 tool schema 的类型语义；对于无法可靠从自然语言提取的字段，会显式降级为“需要显式输入”，而不是伪造错误类型的参数

## CLI 命令参考

```
roll agent add <path|url>       注册本地目录或 Git Agent（解析 SKILL.md + 安装依赖）
roll agent add --remote <url>   注册远程 streamable-http Agent（需配合 --name/--description）
roll agent install <package>    安装并注册已编译 Agent 包
roll agent remove <name>        移除 Agent
roll agent list                 列出所有已注册 Agent
roll agent start <name>         探测 Agent 可连接性（stdio 无需手动启动）
roll agent stop <name>          提示手动停止外部服务（stdio 无需手动停止）
roll agent info <name>          查看 Agent 详情（SKILL.md + tools）
roll agent health               健康检查（stdio 按需模式 / streamable-http 可达性）

roll run <agent> <tool> [args]  声明式调用（支持 --key value / --input-json / --input-file）
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
agent.listen(); // 启动 MCP Server（当前 SDK 提供 stdio 模式）
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
# 或者直接注册远程服务
roll agent add --remote http://localhost:8100/mcp --name wechat-agent --description "微信自动回复"
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
- 当前仓库为 public，CI 发布默认开启 `--provenance`（可通过 `ROLL_NPM_PROVENANCE=false` 临时关闭）
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
