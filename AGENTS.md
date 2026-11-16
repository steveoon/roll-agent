# AGENTS.md

本文件提供仓库级工程约定。先遵守核心规则，再按当前任务读取相关专题；详细契约见下方入口。

## Project Overview

**花卷 Agent (Roll)** — 轻量级 Agent 编排系统。CLI 命令：`roll`，npm 组织：`@roll-agent`。

`@roll-agent/core` 负责 CLI、配置、Agent/MCP 接线与宿主集成；
`@roll-agent/runtime` 负责 ConversationEngine、ThreadStore、策略、Tool Bridge 与 scheduler 账本。
子 Agent 通过 MCP 协议接入。

## 核心架构与行为约束

- 依赖方向为 **Core → Runtime → Protocol / 第三方基础库**；Runtime 的源码、类型、测试与包依赖不得反向依赖 Core。
- 通用执行、取消、预算、压缩、审批及持久化归 Runtime；配置、认证、Provider 适配、Registry/MCP 和 OS 进程管理归 Core。宿主能力由 Runtime 定义中立接口，Core 实现并注入。
- 跨进程契约归 Protocol；Node/Electron 消费者优先使用 client-node。不得把完整配置、认证服务、Registry 或具体 MCP manager 重新传入 Runtime。
- 参数透传不等于功能生效：Provider 变化验证最终请求，执行规则验证 Runtime 状态与实际副作用；边界改动保留默认值、资源所有权和生命周期验证。
- 保持现有 CLI 交互契约；`roll chat` 工具确认使用 clack 选择式提示。交互方式变化需用户明确要求或方案先确认。
- 新增或修改公开行为时同步相关文档；发布型变更按 changeset-workflow 判断版本与 changeset 覆盖。

## 按任务读取

下面的条件指任务实际涉及的行为或契约。修改或审查命中项时，先读取对应文档；跨模块工作读取相关项，范围扩大时补读。纯文字修正按实际需要查阅。

| 任务涉及 | 文档入口 |
| --- | --- |
| 包职责、宿主边界、Agent 注册/集成、SDK 公开契约 | [架构与宿主集成](docs/engineering/architecture.md) |
| 调度状态机、claim/lease、重试/超时、进程树、daemon/service、schedule 命令 | [Scheduler 工程约定](docs/engineering/scheduler.md) |
| 压缩预算、摘要、checkpoint、历史回查、旧会话与协议兼容 | [上下文压缩契约](docs/engineering/context-compaction.md) |
| Sampling、Skills、system prompt、工作区指令、Tool Batch、资源锁 | [Chat 与工具执行](docs/engineering/chat-and-tools.md) |
| 配置发现/迁移、ask 提参、CLI 交互/懒加载、Agent 启动、workspace 依赖 | [Core 接线](docs/engineering/core-integration.md) |
| 发布、打包、workflow 权限、依赖供应链策略或 npm 发布清单 | [发布供应链约束](docs/engineering/release.md) |

涉及 Changesets、semver、版本 PR 或发布验证时，使用 [changeset-workflow](.agents/skills/changeset-workflow/SKILL.md)。定义或修改类型时，使用下述 typescript-magician。

## Development Commands

```bash
# 开发（零编译，Node.js Type Stripping 直接运行 .ts）
pnpm dev                          # 运行 CLI 入口
pnpm dev -- agent list            # 运行子命令

# 构建与检查
pnpm build                        # 构建/混淆各包，并构建 Core React 配置台（输出 dist/）
pnpm typecheck                    # tsc --noEmit 类型检查
pnpm lint                         # ESLint 9 + neostandard
pnpm format                       # Prettier 格式化
pnpm format:check                 # 检查格式

# 测试（node:test + node:assert/strict）
pnpm test                         # 运行所有包的测试
pnpm test:scripts                 # 根级发布/供应链脚本测试
pnpm test:e2e                     # Core E2E
node --experimental-strip-types --experimental-sqlite --test packages/core/src/config/schema.test.ts  # 单文件

# 单包操作
pnpm --filter @roll-agent/core typecheck
pnpm --filter @roll-agent/sdk build
pnpm --filter @roll-agent/smart-reply-agent dev
```

**仓库开发环境**：Node.js 下限以根 `package.json#engines` 为准，pnpm 版本以 `package.json#packageManager` 为准；运行命令前核对当前声明与本地工具链。
发布包大多保持 Node.js ≥22.6.0；Core 启动器会为 Node 22.6–22.12 的 SQLite 命令补
`--experimental-sqlite`。

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

## 日志输出约定

- **stdout** — 仅输出数据（供管道和 `--json` 结构化输出）
- **stderr** — 所有日志、状态信息、彩色输出（chalk/ora）

这是为了避免 stdio 模式下日志干扰 MCP 协议通信。SDK 的 `AgentLogger` 也遵循此规则。

## Testing

使用 Node.js 内置 `node:test` + `node:assert/strict`，零外部测试依赖。测试文件与源码同目录，命名 `*.test.ts`。

## Code Style

- ESLint 9 flat config + neostandard（`noStyle: true` 避免与 Prettier 冲突）
- Prettier：双引号、分号、尾逗号、100 字符行宽
- ESM Only：`"type": "module"`，使用 `import.meta.dirname` 替代 `__dirname`
- CLI 参数命名一律使用 `kebab-case`（如 `--input-json`、`--input-file`），citty 内部自动转为 camelCase 访问。`--help` 输出中呈现的参数名必须是 kebab-case

## 维护这些约定

- 根文件保留稳定的核心规则、常用命令和任务入口；实现细节与完整示例维护在对应专题。
- 新增或搬移约定时同步入口与相对链接，核对规则没有遗漏，并检查根文件字节数，为加载预算留余量。
- 专题是按需读取的完整契约；不要把同一份详细清单复制到多处。可自动检查的规则优先由现有 lint、测试或 CI 执行。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **roll-agent**. Check the live index for freshness and statistics.

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/roll-agent/context` | Codebase overview, check index freshness |
| `gitnexus://repo/roll-agent/clusters` | All functional areas |
| `gitnexus://repo/roll-agent/processes` | All execution flows |
| `gitnexus://repo/roll-agent/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
