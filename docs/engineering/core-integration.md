# Core 配置、CLI 与开发态接线

修改配置发现/迁移、ask 路由与提参、CLI 交互/懒加载、Agent 启动或 workspace 依赖解析时读取。

本文承接根 [AGENTS.md](../../AGENTS.md) 的专项工程约定。下文源码路径均相对于仓库根目录。

## CLI 命令树（citty，懒加载子命令）

```
roll agent add|install|remove|list|start|stop|info|health   Agent 管理
roll run <agent> <tool> [args]               声明式调用
roll ask "<message>"                         LLM 智能路由
roll chat [message]                          会话式入口（Ink TUI；--server 为旧兼容入口）
roll runtime serve --stdio                   Runtime Protocol stdio 服务
roll skills list|get|path|install            Skill 发现、读取与安装
roll browser stop|clear-data                 Browser Runtime 运维
roll companion <enable|disable|status|...>   Companion daemon / relay 管理
roll config set|get|init|migrate             配置管理
roll setup                                   交互式初始配置
roll ui                                      React 配置台
roll update [--check]                        更新 roll 及已注册 Agent
roll schedule add|list|show|remove|pause|resume|run-now|runs|cancel|status|daemon           定时任务
roll schedule service install|uninstall|restart|status                                      用户级调度服务
roll doctor                                  系统诊断
```

## CLI 交互约定

- 不要随意改变已有 CLI 交互方式；交互形态也是产品契约的一部分。
- `roll chat` 的工具确认交互应保持 `clack` 选择式提示（键盘方向键选择，回车确认），不要改成裸 `y/N` 输入，除非用户明确要求或方案已先确认。
- 如果为了 REPL/stdin 复用重构确认逻辑，必须保持用户可见交互不变，并补充测试覆盖确认后输入流仍可继续使用。

## 配置文件发现链

`loadConfig()` 按以下优先级查找配置：
1. `--config` 显式路径
2. 从 `cwd` 向上逐级查找 `roll.config.yaml` / `roll.config.yml`
3. 回退到内置默认配置

加载管线：YAML 解析 → kebab-case→camelCase → `${ENV_VAR}` 替换 → 迁移检测（命中则提示 `roll config migrate`）→ 深度合并默认值 → Zod 校验 → `~/` 路径展开。

Agent 管理命令（start/stop/health/list 等）使用 `loadAgentsConfig()` 只解析 `agents` 段，不应被无关的全局 schema breaking change 误伤。

## 配置迁移（Breaking Schema Change）

- breaking config schema change 不恢复旧字段兼容，而是通过 `config/migration.ts` 注册迁移规则
- `roll config migrate` 负责备份原文件并应用最小自动迁移
- `roll doctor` 与 `roll update --check` 会报告“配置需要迁移”状态
- `roll update` 不隐式改写用户配置，只在升级前后输出高可见提醒

## `roll ask` 两阶段调用与 Tool Schema 语义不可篡改原则

`roll ask` 将自然语言转为 tool 调用，分两阶段：

1. **路由阶段**（`llm-router.ts`）— LLM 只选择 agent + tool，不提取参数
2. **提参阶段**（`extraction-schema.ts` / `argument-extractor.ts`）— LLM 按 tool `inputSchema` 提取参数，preflight 校验后再调用

**核心原则：extraction schema 不得改写原始 tool `inputSchema` 的类型语义。**

- 原始 `inputSchema` 是 MCP tool 的契约，preflight 和 `callTool()` 始终以它为准
- extraction schema 只做“适配 LLM structured output”的变换，例如 `additionalProperties: false`、provider 兼容的 `required` 处理
- **不可提取的字段必须剔除，不得降级类型**。例如 `z.record()` 这类开放 object 无法从自然语言可靠提取，应从 extraction schema 中移除，让 preflight 返回 `needs_input` / `requires_explicit_input`
- 这类参数由 `roll run --input-json` 或上层编排器显式提供

**禁止的反模式：** 为兼容某个 provider 的 structured output 限制，把合法 tool 输入的 schema 类型从 `object` 改成 `string`。这会导致 extraction 产出的类型与 preflight 期望的类型前后不一致，让一整类合法 MCP tool 在 `roll ask` 下不可用。

## CLI 懒加载

citty 子命令通过动态 `import()` 懒加载，CLI 启动不会加载所有命令模块。

### CLI 懒加载发布坑（必读）

- 历史问题：全局安装后执行 `roll agent health` 报错 `Cannot find module .../agent-health.ts`
- 本质原因：`tsc` 的 `rewriteRelativeImportExtensions` 对动态 `import()` 的改写并不总是可靠，某些懒加载写法会在 `dist` 中残留 `.ts` specifier，运行时（只存在 `.js`）直接崩溃
- 编码规则：不要在懒加载点直接写死 `import("./xxx.ts")`；统一用 helper 根据 `import.meta.url` 推断当前后缀（`.ts/.js`），再拼接并 `import()`
- 发布前校验：必须执行 `pnpm --filter @roll-agent/core build && node packages/core/dist/cli/index.js agent health`，无已注册 agent 时输出“暂无已注册 Agent”即通过

## 本地开发态启动回退（Dev Spawn Fallback）

`pnpm dev` 下 roll-core spawn 子 Agent 时读 `package.json#rollAgent.start`（`node dist/index.js`），但 workspace 内 SDK exports 指向 `.ts` 源码，裸 `node` 无法处理。`registry/dev-spawn.ts` 在 spawn 前自动检测并回退：

- 仅 `local-path` / `git` source 生效；`installed-package` / `remote-manifest` 跳过
- 仅 `node` + 单参数 `dist/*.js` + 对应 `src/*.ts` 存在时触发
- 覆盖 on-demand stdio（run/ask/update）和 core-managed（process-manager）两条路径

## Workspace 依赖解析

SDK 的 `exports` 在开发时指向 `./src/index.ts`（直接引用源码），发布时通过 `publishConfig.exports` 指向 `./dist/`。这样 workspace 内其他包（如 `smart-reply-agent`）无需先构建 SDK 即可获得类型。

## Configuration

`roll.config.yaml` — YAML 格式，支持 `${ENV_VAR}` 环境变量引用。Zod schema 定义在 `packages/core/src/config/schema.ts`。
