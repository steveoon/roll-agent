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
pnpm build                        # tsc 构建 + terser 混淆所有包（输出 dist/）
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
pnpm --filter smart-reply-agent dev
```

**环境要求**：Node.js ≥22.6.0，pnpm 10+

## Architecture

### Monorepo 结构（pnpm workspace）

| 包 | 作用 |
|------|------|
| `packages/core` | 指挥官：CLI (citty) + Agent Registry + Router + MCP Client + LLM Engine |
| `packages/sdk` | 子 Agent 开发 SDK：`defineAgent()` + `defineTool()` |
| `packages/browser` | 浏览器运行时抽象层：BrowserRuntime + ContextManager + SessionStore |
| `agents/browser-use` | 浏览器操控 Agent（streamable-http 常驻服务） |
| `agents/smart-reply` | 智能回复 Agent（stdio 按需模式） |

### Agent 三层模型

Agent 注册信息由三个维度描述：

- `source`：`local-path` | `git` | `installed-package` | `remote-manifest`
- `transport`：`stdio` | `streamable-http`
- `runtime ownership`：`on-demand` | `core-managed` | `external-managed`

Installable Agent 通过 `package.json#rollAgent` 提供 runtime 信息，优先于 `SKILL.md metadata` 的 legacy fallback。

非 Node/TypeScript Agent 的接入说明见：

- `docs/how-to-integrate-non-node-agents.md`

当前推荐：

- 本地工具型 Agent：`stdio + local-path`
- 常驻服务型 Agent：`streamable-http + external-managed`
- 非 Node repo 如果不想引入 `package.json`，继续使用 `SKILL.md metadata` 即可

### 双层标准架构

- **描述层**：Agent Skills 标准（SKILL.md frontmatter + body）— 告诉指挥官"我是谁、我会什么"
- **运行时层**：MCP 协议 — 指挥官实际调用子 Agent（stdio 本地子进程 / Streamable HTTP 服务）
- **Runtime Manifest**：`package.json#rollAgent` — 告诉指挥官"怎么启动我、怎么连接我"

### CLI 命令树（citty，懒加载子命令）

```
roll agent add|install|remove|list|start|stop|info|health   Agent 管理
roll run <agent> <tool> [args]               声明式调用
roll ask "<message>"                         LLM 智能路由
roll chat [message]                          Experimental 会话入口骨架
roll config set|get|init|migrate             配置管理
roll update [--check]                        更新 roll 及已注册 Agent
roll doctor                                  系统诊断
```

### Core 模块

- `cli/` — 命令定义 + 终端 UI 工具（chalk/ora/cli-table3）
- `registry/` — SKILL.md 解析（gray-matter）、Agent 发现、注册持久化（~/.roll-agent/）
- `router/` — 声明式路由 + LLM 智能路由
- `mcp/` — MCP Client 连接池（stdio/HTTP 传输）、Sampling 处理
- `llm/` — 统一 LLM 引擎（AI SDK v6 + 多 Provider）
- `config/` — roll.config.yaml 加载、Zod 校验、breaking schema migration 检测

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
- Zod schema 作为单一数据源，接口类型通过 `z.infer<typeof schema>` 或索引访问（如 `Config["ask"]["llmModel"]`）派生
- 泛型约束恰到好处（`extends` 只约束实际使用的属性），避免过度约束或遗漏约束
- 异构集合使用类型擦除基础接口（如 `AnyToolDefinition`），具体泛型接口 extends 基础接口
- 语义性强的值使用 brand type（如 `Confidence`），附带运行时校验工厂函数
- 用 type predicate（`x is T`）替代 `as` 类型断言做收窄
- 用 `Record` mapping / handler pattern 替代 `if-else` / `switch`

### tsconfig 策略

- `tsconfig.base.json` — 开发/IDE 用（noEmit，`"types": ["node"]`）
- `tsconfig.build.json` — 发布构建用（输出 .js + .d.ts，无 source map）
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

### roll chat 的 Skills 接入与 system prompt

chat 走独立的 skill 通道（对齐 `npx skills add` 标准生态，非 roll 私有约定）：

- **发现**：`packages/core/src/skills/library.ts` 的 `createSkillLibrary()` 自动发现项目级 `.agents/skills/*/SKILL.md`（从 cwd 向上查找）+ 用户级 `~/.agents/skills/` + 已注册 Agent 的 SKILL.md + config `skills.dirs` 补充目录；重名按 agent > project > user > config 优先级去重
- **加载告警**：`roll chat` 普通 CLI 与 `--server` JSON-RPC 模式都必须传 `onSkillLibraryIssue`，把 malformed SKILL.md、重名或读取失败等问题写到 stderr，不能静默丢 skill
- **渐进式披露**：`ConversationEngine` 把 skill 目录（name + description）注入 system prompt，模型按需调用内建只读工具 `roll__skill`（`packages/runtime/src/tool-bridge/skill-tool.ts`）加载正文或 `references/` 文件；skill 工具不经 policy 确认门
- **手动指定**：Ink TUI 的 `/` 弹窗把内置命令和可加载 skill 合并展示；`/skills` 列出全部 skill；`/<skill-name> [/<skill-name> ...] 用户请求` 会隐藏注入“先调用 `roll__skill` 加载这些 skill”的指令，用户历史仍显示原始输入。基础 REPL 也支持 `/skills` 和 skill 前缀
- **system prompt**：`packages/runtime/src/engine/system-prompt.ts` 的 `buildChatSystemPrompt()` 组装身份、工具接地纪律（禁止无工具结果声称完成）、任务推进、Skills 目录、输出通道规则。修改 chat 行为指导时改这里，不要在 `agent-session.ts` 里散落字符串
- **测试封闭性**：引擎/会话测试需传 `skillLibrary: null`（引擎）或不传 `skillLibrary`（会话）避免读取真实 `~/.agents/skills`

### 日志输出约定

- **stdout** — 仅输出数据（供管道和 `--json` 结构化输出）
- **stderr** — 所有日志、状态信息、彩色输出（chalk/ora）

这是为了避免 stdio 模式下日志干扰 MCP 协议通信。SDK 的 `AgentLogger` 也遵循此规则。

### CLI 交互约定

- 不要随意改变已有 CLI 交互方式；交互形态也是产品契约的一部分。
- `roll chat` 的工具确认交互应保持 `clack` 选择式提示（键盘方向键选择，回车确认），不要改成裸 `y/N` 输入，除非用户明确要求或方案已先确认。
- 如果为了 REPL/stdin 复用重构确认逻辑，必须保持用户可见交互不变，并补充测试覆盖确认后输入流仍可继续使用。

### 配置文件发现链

`loadConfig()` 按以下优先级查找配置：
1. `--config` 显式路径
2. 从 `cwd` 向上逐级查找 `roll.config.yaml` / `roll.config.yml`
3. 回退到内置默认配置

加载管线：YAML 解析 → kebab-case→camelCase → `${ENV_VAR}` 替换 → 迁移检测（命中则提示 `roll config migrate`）→ 深度合并默认值 → Zod 校验 → `~/` 路径展开。

Agent 管理命令（start/stop/health/list 等）使用 `loadAgentsConfig()` 只解析 `agents` 段，不应被无关的全局 schema breaking change 误伤。

### 配置迁移（Breaking Schema Change）

- breaking config schema change 不恢复旧字段兼容，而是通过 `config/migration.ts` 注册迁移规则
- `roll config migrate` 负责备份原文件并应用最小自动迁移
- `roll doctor` 与 `roll update --check` 会报告“配置需要迁移”状态
- `roll update` 不隐式改写用户配置，只在升级前后输出高可见提醒

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

### 本地开发态启动回退（Dev Spawn Fallback）

`pnpm dev` 下 roll-core spawn 子 Agent 时读 `package.json#rollAgent.start`（`node dist/index.js`），但 workspace 内 SDK exports 指向 `.ts` 源码，裸 `node` 无法处理。`registry/dev-spawn.ts` 在 spawn 前自动检测并回退：

- 仅 `local-path` / `git` source 生效；`installed-package` / `remote-manifest` 跳过
- 仅 `node` + 单参数 `dist/*.js` + 对应 `src/*.ts` 存在时触发
- 覆盖 on-demand stdio（run/ask/update）和 core-managed（process-manager）两条路径

## Workspace 依赖解析

SDK 的 `exports` 在开发时指向 `./src/index.ts`（直接引用源码），发布时通过 `publishConfig.exports` 指向 `./dist/`。这样 workspace 内其他包（如 `smart-reply-agent`）无需先构建 SDK 即可获得类型。

## Configuration

`roll.config.yaml` — YAML 格式，支持 `${ENV_VAR}` 环境变量引用。Zod schema 定义在 `packages/core/src/config/schema.ts`。

## Release & Versioning

使用 [Changesets](https://github.com/changesets/changesets) 管理版本和发布：

```bash
pnpm changeset
pnpm version-packages
pnpm release-packages
pnpm release-github-releases
```

工作流：功能 PR 附带 `.changeset/*.md` → 合入 `main` → GitHub Action 自动创建 release PR（通常标题为 `chore: version packages`）→ 合并该 PR → 自动 publish → 自动创建 GitHub Releases。

### 发布供应链防护检查清单

每个新的 package version 被 publish 前，都必须按以下链路检查：

```
声明层 -> CI 权限层 -> 依赖解析层 -> 构建层 -> tarball 审计层 -> npm 发布层 -> GitHub Release 层
```

| 层级 | 必查点 | 代码/配置位置 | 失败处理 |
|------|------|------|------|
| 声明层 | 发布包必须属于当前 npm scope，且只覆盖 `@roll-agent/core`、`@roll-agent/sdk`、`@roll-agent/browser`、`@roll-agent/reply-authority-client`、`@roll-agent/browser-use-agent`、`@roll-agent/smart-reply-agent` | `scripts/verify-published-packages.mjs` | 不把未知包加入发布清单；先明确包边界 |
| CI 权限层 | GitHub Actions 必须使用 full SHA pin，不能使用 tag；PR CI 和 release workflow 都要满足仓库级 SHA pin 规则 | `.github/workflows/ci.yml`、`.github/workflows/release.yml` | CI 会在下载 action 前失败；先 pin SHA 再重跑 |
| CI 权限层 | workflow 顶层保持 `permissions: {}`；`quality` 只给 `contents: read`；`release` 只给 `contents: write` 和 `pull-requests: write` | `.github/workflows/release.yml` | 不扩大默认 `GITHUB_TOKEN` 权限 |
| CI 权限层 | 本轮发布继续使用 `NPM_TOKEN`；除非正式迁移 Trusted Publishing，否则不能加回 `id-token: write` | `.github/workflows/release.yml` | 需要 Trusted Publishing 时单独设计迁移方案 |
| token 暴露层 | `NPM_TOKEN` 只能注入真正 publish step，不能出现在 install/build/test/verify 步骤 | `.github/workflows/release.yml`、`scripts/release-packages.mjs` | 发现扩大暴露面时必须拆回 publish-only |
| token 暴露层 | GitHub Release 创建必须放在 npm publish 之后的独立 step，只注入 GitHub token，不能注入 `NPM_TOKEN` | `.github/workflows/release.yml`、`scripts/create-github-releases.mjs` | 不把 npm 发布权限和 GitHub 写权限交给同一个第三方 action |
| 依赖解析层 | 使用 `pnpm install --frozen-lockfile`，发布前不能隐式刷新 lockfile | `.github/workflows/*.yml` | lockfile 不一致时先本地审查依赖变化 |
| 依赖解析层 | `minimumReleaseAge: 10080` 必须保留，新解析依赖至少发布满 7 天 | `pnpm-workspace.yaml` | 不能为了临时升级绕过冷却期 |
| 依赖解析层 | `blockExoticSubdeps: true` 必须保留，阻断传递依赖使用 git/tarball 等 exotic source | `pnpm-workspace.yaml` | 需要例外时先做人工供应链审计 |
| 依赖解析层 | `savePrefix: ""` 必须保留，新加依赖默认保存精确版本 | `pnpm-workspace.yaml` | 不机械移除既有 range，但新增依赖应 exact |
| build script 层 | `allowBuilds` denylist 必须显式拒绝当前已知 dependency build scripts，例如 `esbuild`、`unrs-resolver` | `pnpm-workspace.yaml` | 新增 build script 先审计再决定是否允许 |
| 发布 job 层 | `release` job 不能启用 `cache: pnpm`；`quality` job 可以保留 cache | `.github/workflows/release.yml` | 发布 job 发现缓存时必须删除 |
| 发布命令层 | CI publish 必须走 `pnpm release-packages` / `node scripts/release-packages.mjs`，不能直接裸跑 `changeset publish` | `package.json`、`scripts/release-packages.mjs` | 保证 publish 前置校验不会被跳过 |
| 发布命令层 | `scripts/release-packages.mjs` 必须在无 publish token 阶段完成 build 和 verify，只在 publish 窗口临时写入 npm token | `scripts/release-packages.mjs` | 不允许 token 长时间存在于 workspace |
| GitHub Release 层 | npm publish 成功后必须运行 `pnpm release-github-releases`，为当前已发布包版本补齐 GitHub Release | `.github/workflows/release.yml`、`scripts/create-github-releases.mjs` | 不能只发布 npm 而丢失 GitHub Releases |
| tarball 审计层 | packed manifest 禁止 `preinstall`、`install`、`postinstall`、`prepare` lifecycle | `scripts/verify-published-packages.mjs` | 命中即失败，禁止发布 |
| tarball 审计层 | packed files 禁止已知可疑文件名：`router_init.js`、`router_runtime.js`、`tanstack_runner.js`、`setup.mjs`、`gh-token-monitor` | `scripts/verify-published-packages.mjs` | 命中即失败，先定位来源 |
| tarball 审计层 | packed text 必须扫描已知 IoC：`IfYouRevoke`、`toJSON(secrets)`、`.claude/settings`、`.vscode/tasks`、`@tanstack/setup`、`filev2.getsession` | `scripts/verify-published-packages.mjs` | 命中即失败，不能人工忽略 |

发布前最小验证命令：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:scripts
pnpm test:e2e
pnpm build
pnpm verify:published-packages
node scripts/release-packages.mjs --dry-run
node scripts/create-github-releases.mjs --dry-run
```

边界条件：

- 这套防护不替代 npm token 轮换、npm org 2FA enforcement、GitHub App 权限收敛和分支保护。
- 这套防护不要求每次发布新增人工审批，`Changesets -> release PR -> merge -> npm publish` 体验保持不变。
- 这套防护不要求机械移除所有既有 `^` / `~`，但新增依赖默认必须 exact。
- 这套防护不覆盖发布后的 runtime 行为审计；它只阻断 CI 依赖解析、发布 job、packed tarball 和 npm publish 链路中的高风险入口。

## Testing

使用 Node.js 内置 `node:test` + `node:assert/strict`，零外部测试依赖。测试文件与源码同目录，命名 `*.test.ts`。

## Code Style

- ESLint 9 flat config + neostandard（`noStyle: true` 避免与 Prettier 冲突）
- Prettier：双引号、分号、尾逗号、100 字符行宽
- ESM Only：`"type": "module"`，使用 `import.meta.dirname` 替代 `__dirname`
- CLI 参数命名一律使用 `kebab-case`（如 `--input-json`、`--input-file`），citty 内部自动转为 camelCase 访问。`--help` 输出中呈现的参数名必须是 kebab-case

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **roll-agent** (7004 symbols, 17715 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/roll-agent/context` | Codebase overview, check index freshness |
| `gitnexus://repo/roll-agent/clusters` | All functional areas |
| `gitnexus://repo/roll-agent/processes` | All execution flows |
| `gitnexus://repo/roll-agent/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
