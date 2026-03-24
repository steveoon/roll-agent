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
                ├── Runtime Manifest（package.json#rollAgent）
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
- `roll chat` 已预留为未来会话式统一入口，但当前仅提供 experimental 命令骨架，不做多步编排。
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

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ~/.roll-agent/agents
```

支持的 provider：`anthropic`、`openai`、`deepseek`、`qwen`。每个 provider 可配置 `base-url` 用于自定义 API 端点。
`ask.llmModel` 可选；未设置时会回退到 `llm.defaultModel`。

如果本地还留着旧版 `router:` 配置段：

- `roll doctor` 会提示“配置需要迁移”
- `roll update --check` / `roll update` 会给出迁移提醒
- 可直接运行：

```bash
roll config migrate
```

它会自动备份原文件，再将已知旧字段迁到新 schema。

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
pnpm dev -- agent add ./agents/browser-use

# 已编译 npm 包（分发态）
pnpm dev -- agent install @roll-agent/browser-use-agent

# Git URL
pnpm dev -- agent add https://github.com/someone/my-agent.git

# 远程 MCP 服务
pnpm dev -- agent add --remote https://example.com/mcp --name remote-agent --description "远程 Agent"
```

说明：

- `browser-use-agent` 当前默认使用系统 Chrome，不会在安装时自动下载 Playwright Chromium
- 如果后续需要显式使用 Playwright 自带 Chromium，再单独补 setup/配置更合理

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
pnpm dev -- run browser-use-agent zhipin_read_messages --limit 10

# 显式传入结构化 JSON（适合 object / record / 复杂 payload）
pnpm dev -- run smart-reply-agent sync_brand_data \
  --input-json '{"cityName":"上海市","brandAlias":"肯德基"}'

# 或从文件读取完整 payload
pnpm dev -- run some-agent sync_config --input-file ./payload.json

# LLM 智能路由（自然语言，自动选择 Agent + Tool）
pnpm dev -- ask "帮我查看未读消息"

# 未来会话式入口（experimental，当前只返回 unavailable）
pnpm dev -- chat "帮我把这批候选人处理掉"
```

说明：

- `roll run` 现在同时支持 `--key value`、`--input-json`、`--input-file`
- `--input-json` / `--input-file` 适合传递复杂对象参数；命令行 `--key value` 更适合简单标量参数
- `roll ask` 适合“自然语言可以可靠映射到 tool 参数”的场景；如果某个必填字段是开放对象（如 `z.record()` / 任意 JSON payload），`ask` 会返回 `needs_input`，提示改用 `roll run --input-json` 或上层编排器显式提供
- `roll ask` 不会篡改原始 tool schema 的类型语义；对于无法可靠从自然语言提取的字段，会显式降级为“需要显式输入”，而不是伪造错误类型的参数
- `roll chat` 当前是 experimental 骨架，不会执行会话编排、不会恢复 session，也不会隐式降级到 `roll ask`

## CLI 命令参考

```
roll agent add <path|url>       注册本地目录或 Git Agent（解析 SKILL.md + 安装依赖）
roll agent add --remote <url>   注册远程 streamable-http Agent（需配合 --name/--description）
roll agent install <package>    安装并注册已编译 Agent 包
roll agent remove <name>        移除 Agent
roll agent list                 列出所有已注册 Agent
roll agent start <name>         启动 Agent（兼容 on-demand / core-managed / external-managed）
roll agent stop <name>          停止 Agent（core-managed HTTP 可由 Roll 托管）
roll agent info <name>          查看 Agent 详情（SKILL.md + tools）
roll agent health               健康检查（兼容 on-demand / core-managed / external-managed）

roll run <agent> <tool> [args]  声明式调用（支持 --key value / --input-json / --input-file）
roll ask "<message>"            LLM 智能路由
roll chat [message]             Experimental：未来会话式统一入口（当前仅提供骨架）
roll update                     更新 roll 及已注册的 Agent（对不同来源行为不同）
roll update --check             检查 roll/Agent 更新，并提醒配置迁移问题

roll config init                交互式初始化配置
roll config get [key]           查看配置（支持点号路径如 llm.defaultModel）
roll config set <key> <value>   修改配置
roll config migrate             自动迁移旧版配置（备份原文件 + 写回新格式）

roll doctor                     诊断系统状态（Node.js / 配置 / Provider / Agent）
roll doctor --json              JSON 诊断结果（配置损坏时返回非零退出码）
```

说明：`--json` 为子命令级参数（在支持的命令上可用）；全局 `--verbose` / `--config <path>`
当前为 planned，尚未统一透传到所有子命令。

## Skill Agent 接入

当 `roll-core` 被当作上层编排器或支持 SKILL 的 coding agent 的一个 CLI skill 使用时，推荐默认调用顺序为：

- 已知 `agent + tool` 时优先 `roll run --json`
- 只知道自然语言意图时使用 `roll ask --json`
- 不要默认使用 `roll chat`，它当前仍是 experimental

可直接参考模板：[openclaw-roll-core-skill-template/SKILL.md](./openclaw-roll-core-skill-template/SKILL.md)。

如果只想单独拉取这个 skill 模板目录，可用 sparse-checkout：

```bash
git clone --filter=blob:none --no-checkout https://github.com/steveoon/roll-agent.git
cd roll-agent
git sparse-checkout init --cone
git sparse-checkout set openclaw-roll-core-skill-template
git checkout main
```

拉取完成后，可直接复制整个目录：

```bash
cp -R openclaw-roll-core-skill-template /path/to/your/skills/roll-core
```

## Agent 更新注意事项

- `roll update` 现在会刷新 `git` / `installed-package` / `local-path` Agent 的本地 metadata
- 对正在运行的 `core-managed` HTTP Agent，`roll update` 会在刷新后自动重启并重新探活
- 对 `external-managed` 远程服务，代码/工具逻辑更新后仍需要你在外部重启服务
- 如果改的是 Agent 名称或分发来源，仍建议 `roll agent remove` 后重新注册
- 如果 `roll update` 同时提示本地配置 schema 需要迁移，它不会阻塞 self-update；升级完成后可执行 `roll config migrate`

完整说明见：[docs/how-to-update-registered-agents.md](./docs/how-to-update-registered-agents.md)。

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
agent.listen(); // 默认以 stdio MCP Server 启动

// 也支持显式启动为 HTTP MCP 服务
// await agent.listen({
//   transport: { type: "http", host: "127.0.0.1", port: 3100 },
// });
```

对于 `local-path` / legacy fallback 场景，可在 SKILL.md metadata 中声明运行时信息：

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

如果 Agent 需要作为 npm installable package 分发，推荐把 runtime 信息迁到 `package.json#rollAgent`，让 `SKILL.md` 只负责名字、描述和工具说明。

### 方式 B：任意语言（实现 MCP Server）

任何语言的 MCP Server 都可以接入（Python/Go/Rust/Java 均有官方 SDK）。

- 对 `local-path` / `remote-manifest` 注册，可继续在 `SKILL.md` 中声明 legacy runtime metadata
- 对 npm installable Agent，优先使用 `package.json#rollAgent`
- 如果是非 Node Agent，本地接入通常优先 `stdio`，常驻服务通常优先 `streamable-http`

下面是 `remote-manifest` / legacy fallback 的最小示例：

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

完整接入指南见：

- [docs/how-to-integrate-non-node-agents.md](./docs/how-to-integrate-non-node-agents.md)

## 项目结构

```
packages/
  core/          指挥官：CLI + Registry + Router + MCP Client + LLM Engine
  sdk/           子 Agent 开发 SDK：defineAgent() + defineTool()
  browser/       浏览器运行时抽象层：BrowserRuntime + ContextManager + SessionStore
agents/
  browser-use/   浏览器操控 Agent（17 个 tool，streamable-http 常驻服务）
  smart-reply/   智能回复 Agent（stdio 按需模式）
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

使用 [Changesets](https://github.com/changesets/changesets) 管理版本和发布。

### 日常工作流

```bash
# 1. 开发完成后创建 changeset（选择影响的包 + semver 级别）
pnpm changeset

# 2. 将 .changeset/*.md 文件随 PR 一起提交
git add .changeset/ && git commit -m "chore: add changeset"

# 3. 合入 main 后 GitHub Action 自动开 release PR（标题通常为 "chore: version packages"）
#    审批合入该 PR → 自动 publish 到 npm
```

### 本地操作（调试/紧急发布）

```bash
pnpm version-packages              # 应用 changeset，更新版本号 + CHANGELOG
pnpm release-packages              # 构建 + 发布到 npm
pnpm release:legacy:dry-run        # 旧脚本 dry-run（诊断用）
```

### 发布包列表

- `@roll-agent/sdk`
- `@roll-agent/browser`
- `@roll-agent/core`
- `@roll-agent/browser-use-agent`

内部依赖自动级联：修改 `@roll-agent/browser` 会自动 bump `browser-use-agent` 的依赖版本。

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
| 版本管理 | Changesets（自动版本号 + CHANGELOG + npm publish） |

## License

MIT
