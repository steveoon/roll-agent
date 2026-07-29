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
- `roll chat` 已提供 experimental 多轮会话：支持 Agent tool 编排、session 持久化/恢复、Skills、thinking 档位切换与执行中 Esc 中断。
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

支持的 provider：`anthropic`、`openai`、`deepseek`、`qwen`、`xai`。每个 provider 可配置
`base-url` 用于自定义 API 端点；xAI 默认模型为 `grok-4.5`（500k context window），API key 可通过
`XAI_API_KEY` 注入。
`ask.llm-model` 可选；未设置时会回退到 `llm.default-model`。

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

- 本地源码目录 / Git 仓库请使用 `roll agent add`
- `roll agent install` 适用于已编译 npm 包或 `.tgz` 包，不适用于本地源码目录
- `browser-use-agent` 当前默认使用系统 Chrome，不会在安装时自动下载 Playwright Chromium
- 如果后续需要显式使用 Playwright 自带 Chromium，再单独补 setup/配置更合理

如果你安装的是 `smart-reply-agent` 这类需要独立环境变量的 Agent，推荐在 `roll.config.yaml` 中通过 `agents.env` 为它单独注入配置：

```yaml
agents:
  data-dir: ~/.roll-agent/agents
  env:
    smart-reply-agent:
      REPLY_AUTHORITY_URL: https://reply-authority.duliday.com
      REPLY_AUTHORITY_BEARER_TOKEN: ${REPLY_AUTHORITY_BEARER_TOKEN}
```

这样 `roll-core` 在启动 `smart-reply-agent` 的 stdio 子进程时会自动注入这些变量，不需要用户手工在 shell 里 `export` 一大串值。

### 3. 使用 Web 配置台

```bash
roll ui
```

`roll ui` 会按配置发现链读取 `roll.config.yaml`，在随机的 `127.0.0.1` 端口启动一次性本地配置台，并自动打开默认浏览器。配置台同时支持结构化表单和 YAML 编辑，保存前会展示校验结果、差异以及生效方式；退出终端进程后服务随即关闭。

```bash
roll ui --no-open                 # 不自动打开浏览器，改为打印一次性链接
roll ui --config ./roll.config.yaml
```

配置字段由 `rollConfigSchema` 自动生成，Agent 环境变量由各 Agent 的 `references/env.yaml` 自动生成；CLI 与 Web UI 共用 key 编码、Zod 校验和安全写回链路，但读取视图按用途区分。详细机制、维护边界与生效规则见 [`docs/how-to-use-roll-ui.md`](docs/how-to-use-roll-ui.md)。

### 4. 调用 Agent

```bash
# 直接调用（明确指定 Agent + MCP tool）
pnpm dev -- run browser-use-agent zhipin_read_messages --limit 10

# 显式传入结构化 JSON（适合 object / record / 复杂 payload）
pnpm dev -- run smart-reply-agent generate_reply \
  --input-json '{"candidateMessage":"你好，请问薪资是多少？","target":{"platform":"zhipin","tenantId":"tenant-001","conversationId":"685501091-0","candidateId":"candidate-123"}}'

# 或从文件读取完整 payload
pnpm dev -- run some-agent sync_config --input-file ./payload.json

# LLM 智能路由（自然语言，自动选择 Agent + Tool）
pnpm dev -- ask "帮我查看未读消息"

# 会话式入口（experimental；无 message 时进入交互 TUI）
pnpm dev -- chat "帮我把这批候选人处理掉"
```

说明：

- `roll run` 现在同时支持 `--key value`、`--input-json`、`--input-file`
- `--input-json` / `--input-file` 适合传递复杂对象参数；命令行 `--key value` 更适合简单标量参数
- `roll ask` 适合“自然语言可以可靠映射到 tool 参数”的场景；如果某个必填字段是开放对象（如 `z.record()` / 任意 JSON payload），`ask` 会返回 `needs_input`，提示改用 `roll run --input-json` 或上层编排器显式提供
- `roll ask` 不会篡改原始 tool schema 的类型语义；对于无法可靠从自然语言提取的字段，会显式降级为“需要显式输入”，而不是伪造错误类型的参数
- `roll chat` 支持交互式多轮编排与 session 恢复；仍为 experimental，且不会隐式降级到 `roll ask`

### `roll chat` 终端界面模式

`roll chat` 默认使用 `auto`：普通交互式 TTY（包括普通 tmux pane）进入全屏 TUI；
CI、非 TTY、`TERM=dumb`、screen reader、Zellij、tmux control mode 或无法确认的 tmux
环境自动回退到基础 REPL。

```yaml
chat:
  screen-mode: auto # auto | fullscreen | inline
```

- 临时覆盖：`roll chat --screen-mode fullscreen` 或 `roll chat --screen-mode inline`
- 历史浏览：`PageUp` / `PageDown`，`Ctrl+Home` 跳到最早处，`Ctrl+End` 返回最新内容；全屏模式也支持鼠标滚轮
- 终端缩放：全屏 TUI 会按最新宽高重排，输入框保持有界，长历史只渲染当前视口附近内容
- 中文输入法：全屏 TUI 会把真实终端光标锚定到输入位置；受支持终端中的拼音预编辑与候选窗口通常无需额外配置
- 会话退出：恢复进入 TUI 前的主屏内容，并输出 session ID、消息数和继续命令

`--screen-mode` 只适用于没有起始 message 的交互会话，不能与 `--json`、`--server` 或
`--list` 同用。显式指定 `fullscreen` 但 stdin/stdout 不具备交互能力时会直接报错。

## CLI 命令参考

```
roll agent add <path|url>       注册本地目录或 Git Agent（解析 SKILL.md + 安装依赖）
roll agent add --remote <url>   注册远程 streamable-http Agent（需配合 --name/--description）
roll agent install <package>    安装并注册已发布 Agent npm 包（本地源码目录/Git URL 请改用 add）
roll agent remove <name>        移除 Agent
roll agent list                 列出所有已注册 Agent
roll agent tools <name>         查看 Agent 暴露的 MCP tools 及输入 schema
roll agent start <name>         启动由 Roll 托管的 core-managed Agent
roll agent stop <name>          停止由 Roll 托管的 core-managed Agent
roll agent stop <name> --recover 非交互确认恢复可安全验证的中断租约后停止
roll agent info <name>          查看 Agent 详情（SKILL.md / runtime / env）
roll agent health               健康检查并报告中断租约（不自动恢复）

roll run <agent> <tool> [args]  直接调用 MCP tool（支持 --key value / --input-json / --input-file）
roll ask "<message>"            用 LLM 从自然语言中选择 Agent 和 MCP tool
roll chat [message]             Experimental：多轮会话、Agent tools、Skills 与 session 恢复
roll update                     检查并更新 roll 及已注册 Agent（对不同来源行为不同）
roll update --check             仅检查 roll/Agent 更新，不执行安装或刷新

roll config init                交互式初始化配置
roll config get [key]           查看配置（支持英文句点路径，如 llm.default-model）
roll config set <key> <value>   修改配置（key 用英文句点分隔，如 ask.confirm-threshold）
roll config migrate             自动迁移旧版配置（备份原文件 + 写回新格式）
roll ui                         启动按需本地 Web 配置台（127.0.0.1 随机端口）

roll doctor                     诊断 Roll 配置、Agent 注册表和运行时状态
roll doctor --json              JSON 诊断结果（配置损坏时返回非零退出码）
```

常用选项：

| 命令 | 选项 | 作用 |
|------|------|------|
| `roll agent install` | `--skip-browser-setup` | 跳过 Playwright 浏览器运行时安装/校验 |
| `roll agent install` | `--no-start` | 安装后不自动启动 `core-managed` Agent |
| `roll agent stop` | `--recover` | 非交互确认恢复；活动或无法验证的租约仍会拒绝 |
| `roll update` | `--check` | 仅检查可用更新，不执行安装或刷新 |
| `roll update` | `--skip-browser-setup` | 更新 Agent 后跳过 Playwright 浏览器运行时安装/校验 |
| `roll run` | `--input-json <json>` | 以 JSON 字符串提供完整 tool 输入对象 |
| `roll run` | `--input-file <path>` | 从 JSON 文件读取完整 tool 输入对象 |
| `roll chat` | `--screen-mode <auto\|fullscreen\|inline>` | 选择全屏 TUI、基础 REPL 或自动检测 |
| `roll ui` | `--no-open` | 不自动打开浏览器，打印一次性认证链接 |
| `roll ui` | `--config <path>` | 显式指定要编辑的配置文件 |
| 支持 JSON 输出的命令 | `--json` | 输出结构化 JSON |

说明：`--verbose` 可用于全局或 `roll run` / `roll ask` 输出调试日志；`--config <path>`
目前是 `roll ui` 的稳定命令选项，并不是其他命令通用的全局选项。

## Skill Agent 接入

当 `roll-core` 被当作上层编排器或支持 SKILL 的 coding agent 的一个 CLI skill 使用时，推荐默认调用顺序为：

- 已知 `agent + tool` 时优先 `roll run --json`
- 只知道自然语言意图时使用 `roll ask --json`
- 需要人工交互、多轮工具编排或 session 恢复时使用 `roll chat`；自动化与结构化管道仍优先 `roll run --json` / `roll ask --json`

### 招聘回复编排约定

当上层 orch 组合 `browser-use-agent` 与 `smart-reply-agent` 处理 BOSS 直聘聊天时：

- 调 `smart-reply-agent.generate_reply` 前，先尝试从页面读取并透传：
  - `candidateInfo.communicationPosition`
  - `candidateInfo.expectedLocation`
  - `candidateInfo.expectedPosition`
- `preferredBrand`：`zhipin_get_candidate_info` 在 `communicationPosition` 含连字符类分隔符（`-` / `－` / `—` / `–`）时自动取第一段透传，例如"肯德基-服务员"→`preferredBrand: "肯德基"`；无分隔符时不输出；服务端也会基于租户配置做品牌解析，两者互补
- 严禁把通用岗位名（如“餐饮兼职服务员”“门店服务员”）或候选人现/前雇主公司名当作 `preferredBrand`
- `diagnostics.brandResolutionSource="none"` 是合法结果，不是调用失败；是否补问用户或转人工，由 orch 自己决定

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

会读写共享资源的 Tool 可以声明 `annotations` 和 `resourceHints`，让 `roll chat` 在同一
model step 内并行无冲突调用，同时串行化同一资源的读写冲突：

```typescript
const writeFile = defineTool({
  name: "write_file",
  description: "写入工作区文件",
  input: z.object({ path: z.string(), content: z.string() }),
  output: z.object({ written: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: true },
  resourceHints: [{ field: "path", kind: "file", mode: "write" }],
  execute: async ({ path, content }) => {
    // ...
    return { written: true };
  },
});
```

`field` 必须指向顶层 input 字段；它可以是单个资源 ID 或资源 ID 数组。stdio Agent 的相对
文件路径以 Agent 安装目录为基准。未提供资源线索的外部副作用 Tool 会按 Agent 级别保守串行。

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

### 第三方 Web UI / GUI

第三方 UI 使用版本化 Runtime Protocol，不直接依赖 `ConversationEngine`：

```bash
roll runtime serve --stdio
```

- [架构与安全边界](./docs/runtime-protocol-architecture.md)
- [Runtime Protocol v1 参考](./docs/runtime-protocol-v1-reference.md)
- [`@roll-agent/client-node` API 参考](./docs/client-node-reference.md)
- [`@roll-agent/companion` Relay v1 参考](./docs/companion-relay-v1-reference.md)
- [使用 Electron、Tauri、Python 或 Next.js 接入](./docs/how-to-build-roll-runtime-ui.md)
- [最小客户端教程](./docs/tutorial-runtime-ui-quickstart.md)

## 项目结构

```
packages/
  core/          指挥官：CLI + Registry + Router + MCP Client + LLM Engine
  protocol/      第三方 UI 的版本化 Runtime Protocol + JSON Schema
  client-node/   stdio Runtime Protocol Node 客户端
  companion/     远程 Web 的本地 Companion / 出站 Relay bridge 基础能力（不含 Cloud Relay）
  sdk/           子 Agent 开发 SDK：defineAgent() + defineTool()
  browser/       浏览器运行时抽象层：BrowserRuntime + ContextManager + SessionStore
agents/
  browser-use/   浏览器操控 Agent（17 个 tool，streamable-http 常驻服务）
  smart-reply/   智能回复 Agent（stdio 按需模式）
```

## 开发

```bash
pnpm dev                          # 运行 CLI
pnpm build                        # tsc 构建所有包，并由 Vite 打包 core 的 React 配置台
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
#    审批合入该 PR → 自动 publish 到 npm → 创建 GitHub Releases
```

### 本地操作（调试/紧急发布）

```bash
pnpm version-packages              # 应用 changeset，更新版本号 + CHANGELOG
pnpm release-packages              # 构建 + 发布到 npm
pnpm release-github-releases -- --dry-run  # 预览将补齐的 GitHub Releases
pnpm release:legacy:dry-run        # 旧脚本 dry-run（诊断用）
```

### 发布包列表

- `@roll-agent/sdk`
- `@roll-agent/browser`
- `@roll-agent/core`
- `@roll-agent/runtime`
- `@roll-agent/protocol`
- `@roll-agent/client-node`
- `@roll-agent/companion`
- `@roll-agent/reply-authority-client`
- `@roll-agent/browser-use-agent`
- `@roll-agent/smart-reply-agent`

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
| Web 配置台 | React + Tailwind CSS |
| 构建 | tsc（输出 .js + .d.ts）+ Vite（打包配置台静态资源） |
| 包管理 | pnpm workspace |
| 版本管理 | Changesets（自动版本号 + CHANGELOG + npm publish） |

## License

MIT
