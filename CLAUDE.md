# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
| `agents/browser-use` | 浏览器操控 Agent（17 个 tool，streamable-http 常驻服务） |
| `agents/smart-reply` | 智能回复 Agent（stdio 按需模式） |

### Agent 三层模型

Agent 注册信息由三个独立维度描述，不互相绑定：

- **source**（分发来源）：`local-path` | `git` | `installed-package` | `remote-manifest`
- **transport**（MCP 通信方式）：`stdio` | `streamable-http`
- **runtime ownership**（生命周期管理者）：`on-demand`（run/ask 按需拉起）| `core-managed`（roll start/stop 托管）| `external-managed`（用户自行管理）

Installable agent 通过 `package.json#rollAgent` manifest 声明 runtime 配置，优先于 SKILL.md metadata。

非 Node/TypeScript Agent 的接入文档见：

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
- `config/` — roll.config.yaml 加载、Zod 校验、配置迁移检测与迁移执行（`migration.ts`）

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

### 构建与混淆

各包 build 脚本统一为 `tsc → scripts/obfuscate.mjs`：

1. `tsc -p tsconfig.build.json` — 编译 .ts → .js + .d.ts
2. `scripts/obfuscate.mjs` — terser 压缩 + mangle（`keep_classnames: true`），删除 .map 文件，strip sourceMappingURL

`.d.ts` 文件不受混淆影响，TypeScript 消费者的类型体验不变。开发模式（`pnpm dev`/`pnpm test`）使用 `--experimental-strip-types` 直接运行 .ts，不经过 dist。

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
- **工作区工程约定**：`packages/runtime/src/engine/workspace-instructions.ts` 从 cwd 向上找最近一层 `AGENTS.md`（优先）/ `CLAUDE.md`，每轮按 mtime/size 缓存刷新；`system-prompt.ts` 的 `# 工作区工程约定` 段在 `# 输出` 之后；`ConversationEngine` 按 `chat.instructions`（auto | off | path）构造 source，三入口共用；告警走 `onWorkspaceInstructionsIssue` → stderr
- **测试封闭性**：引擎/会话测试需传 `skillLibrary: null`（引擎）或不传 `skillLibrary`（会话）避免读取真实 `~/.agents/skills`；需要隔离工作区约定时引擎传 `workspaceInstructions: null`（会话不传 `workspaceInstructions`）

### 日志输出约定

- **stdout** — 仅输出数据（供管道和 `--json` 结构化输出）
- **stderr** — 所有日志、状态信息、彩色输出（chalk/ora）

这是为了避免 stdio 模式下日志干扰 MCP 协议通信。SDK 的 `AgentLogger` 也遵循此规则。

### 配置文件发现链

`loadConfig()` 按以下优先级查找配置：
1. `--config` 显式路径
2. 从 `cwd` 向上逐级查找 `roll.config.yaml` / `roll.config.yml`
3. 兜底 `~/roll.config.yaml`（全局配置，`roll setup` / `roll config init` / `config setup` 在未发现任何配置时也写到这里）
4. 回退到内置默认配置

加载管线：YAML 解析 → kebab-case→camelCase → `${ENV_VAR}` 替换 → **迁移检测**（命中则抛错提示 `roll config migrate`）→ 深度合并默认值 → Zod 校验 → `~/` 路径展开。

Agent 管理命令（start/stop/health/list 等）使用 `loadAgentsConfig()` 只解析 `agents` 段，不受全局 schema breaking change 影响。

### `roll ask` 两阶段调用与 Tool Schema 语义不可篡改原则

`roll ask` 将自然语言转为 tool 调用，分两阶段：

1. **路由阶段**（`llm-router.ts`）— LLM 选择 agent + tool，不提取参数
2. **提参阶段**（`extraction-schema.ts`）— LLM 按 tool inputSchema 提取参数，preflight 校验后调用

**核心原则：extraction schema 不得改写原始 tool inputSchema 的类型语义。**

- 原始 `inputSchema` 是 MCP tool 的契约，preflight 和 `callTool()` 始终以它为准
- extraction schema 只做"适配 LLM structured output"的变换（如 OpenAI strict mode 要求 `additionalProperties: false`、所有字段进 `required`）
- **不可提取的字段必须剔除，不得降级类型**。例如 `z.record()` 这类开放 object 无法从自然语言可靠提取，应从 extraction schema 中移除，让 preflight 返回 `needs_input`，而非将 `type: "object"` 偷换成 `type: "string"`
- 不可提取的参数由 `roll run --input-json` 或上层编排器显式提供

**反模式（禁止）：** 为兼容某个 provider 的 structured output 限制，把合法 tool 输入的 schema 类型从 object 改成 string。这会导致 extraction 产出的类型与 preflight 期望的类型前后不一致，让一整类合法 MCP tool 在 `roll ask` 下直接不可用。

**判断标准：** 如果一个 schema 变换使得 `createExtractionSchema(s)` 产出的某字段类型与 `s` 中对应字段的原始类型不同，这个变换就是有问题的。

### CLI 懒加载

citty 子命令通过动态 `import()` 懒加载，CLI 启动不会加载所有命令模块。

#### CLI 懒加载发布坑（必读）

- 历史问题：全局安装后执行 `roll agent health` 报错 `Cannot find module .../agent-health.ts`
- 本质原因：`tsc` 的 `rewriteRelativeImportExtensions` 对动态 `import()` 的改写并不总是可靠，某些懒加载写法会在 `dist` 中残留 `.ts` specifier，运行时（只存在 `.js`）直接崩溃
- 编码规则：不要在懒加载点直接写死 `import("./xxx.ts")`；统一用 helper 根据 `import.meta.url` 推断当前后缀（`.ts/.js`），再拼接并 `import()`
- 发布前校验：必须执行 `pnpm --filter @roll-agent/core build && node packages/core/dist/cli/index.js agent health`，无已注册 agent 时输出“暂无已注册 Agent”即通过

### Dev Spawn Fallback（开发模式自动 type-strip）

`pnpm dev` 下 roll-core 自身有 `--experimental-strip-types`，但 spawn 子 Agent 子进程时读的是 `package.json#rollAgent.start`（生产配置 `node dist/index.js`）。workspace 内 SDK 的 exports 指向 `src/index.ts`，裸 `node` 无法处理 `.ts`。

`registry/dev-spawn.ts` 提供共享 helper `resolveDevSpawnSpec()`，在 spawn 前自动检测并降级：

- 仅对 `local-path` / `git` source 生效（`installed-package` / `remote-manifest` 跳过）
- 仅当 `node` + 单参数 `dist/*.js` + 对应 `src/*.ts` 存在时触发
- 将 `node dist/index.js` → `node --experimental-strip-types src/index.ts`

调用点在 `run.ts`、`ask.ts`、`update.ts`（on-demand stdio）和 `process-manager.ts`（core-managed），均在调用 `connect()` / `spawn()` 之前解析。`McpClientManager.connect()` 签名不感知此机制。

## Workspace 依赖解析

SDK 的 `exports` 在开发时指向 `./src/index.ts`（直接引用源码），发布时通过 `publishConfig.exports` 指向 `./dist/`。这样 workspace 内其他包（如 `smart-reply-agent`）无需先构建 SDK 即可获得类型。

## Configuration

`roll.config.yaml` — YAML 格式，支持 `${ENV_VAR}` 环境变量引用。Zod schema 定义在 `packages/core/src/config/schema.ts`。

### 配置迁移（Breaking Schema Change 处理）

当配置 schema 发生 breaking change 时，通过 `config/migration.ts` 中的规则注册制处理：

- 迁移规则注册在 `CONFIG_MIGRATION_RULES` 数组，每条规则实现 `inspect(document)` + `apply(document)` 接口
- `loadConfig()` 在 Zod 校验前调用 `detectKnownConfigMigrations()`，命中则抛错引导用户运行 `roll config migrate`
- `roll config migrate` 自动备份原文件（`.bak.<timestamp>`）再写回迁移后的 YAML
- 冲突场景（新旧字段同时存在且值不同）拒绝自动迁移，要求手动处理
- `roll doctor` 和 `roll update --check` 会检测并报告待迁移状态

**添加新迁移规则**：在 `CONFIG_MIGRATION_RULES` 数组中追加一条 `{ id, inspect, apply }`，`doctor`/`update`/`loadConfig` 自动生效。

## Testing

使用 Node.js 内置 `node:test` + `node:assert/strict`，零外部测试依赖。测试文件与源码同目录，命名 `*.test.ts`。

## Release & Versioning

使用 [Changesets](https://github.com/changesets/changesets) 管理版本和发布：

```bash
pnpm changeset                    # 创建 changeset（选包 + semver 级别）
pnpm version-packages             # 应用 changeset，更新版本号 + CHANGELOG
pnpm release-packages             # 构建 + 发布到 npm
```

**工作流**：PR 中运行 `pnpm changeset` 生成 `.changeset/*.md` → 合入 main → GitHub Action 自动开 release PR（通常标题为 `chore: version packages`）→ 审批合入 → 自动 publish。

`updateInternalDependencies: "patch"` — 修改 `@roll-agent/browser` 会自动 bump 依赖它的 `browser-use-agent`。

旧的 `scripts/release.mjs` 保留为本地诊断工具（`pnpm release:legacy:dry-run`）。

## Code Style

- ESLint 9 flat config + neostandard（`noStyle: true` 避免与 Prettier 冲突）
- Prettier：双引号、分号、尾逗号、100 字符行宽
- ESM Only：`"type": "module"`，使用 `import.meta.dirname` 替代 `__dirname`
- CLI 参数命名一律使用 `kebab-case`（如 `--input-json`、`--input-file`），citty 内部自动转为 camelCase 访问。`--help` 输出中呈现的参数名必须是 kebab-case

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **roll-agent** (14821 symbols, 41048 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
