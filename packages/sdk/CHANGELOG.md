# @roll-agent/sdk

## 0.3.0

### Minor Changes

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`8e592b3`](https://github.com/steveoon/roll-agent/commit/8e592b3d24716b9bcb624eb29fddf3c1040a451a) Thanks [@steveoon](https://github.com/steveoon)! - 同一 `browserInstance` 的页面操作工具在服务端互斥串行，修复 chat 模式并行 tool call 在同一浏览器实例上互相踩踏的竞态。

  **browser-use-agent**：新增 per-browserInstance 互斥队列（`browser-instance-lock.ts`），经 `withBrowserInstanceInput` 接入——同实例页面操作排队依次执行，不同实例保持并行。严格 page-free 的 `browser_status`、`list_pages`、`attach_browser_session` 不进锁，保证实例被长操作占用时仍有读状态排障出口；`zhipin_diagnose_browser_state` 当前也保留为不进锁的诊断入口，但不再声明为纯只读，调用涉及 native focus/input 的 phase 时仍应避免和页面操作并发（`browser_stop`、`zhipin_judge_prepared_reply` 本就绕过实例包装，不受影响）。发生争用时输出排队等待日志。

  **@roll-agent/sdk**：`AgentContext` 新增可选 `signal: AbortSignal`（per-request），`registerTool` 将 MCP 请求的取消信号透传给工具。排队等待期间客户端已超时/取消的请求，出队时会被直接丢弃并返回 `cancelled_while_queued`（含 `browserInstance` 与 `queuedMs` details），保证"客户端已放弃的请求不再落地执行"，避免超时重试导致 `say_hello`/`exchange_wechat` 这类副作用操作重复执行的幽灵操作风险。

  对遵守 one worker → one browserInstance 编排规范的 orchestrator 零行为变化：同实例顺序调用永远无锁争用。SKILL.md 已同步说明排队语义与"超时重试前先用读工具验证"的指引。

## 0.2.1

### Patch Changes

- 静默 `roll chat` 自动启用 `node:sqlite` 时的实验特性提示,并在 `roll update` 遇到 `@roll-agent/*` 新包 registry metadata 短暂 `E404` 时重试安装。

  SDK：`defineAgent` 的 `logLevel` 现在支持从 `ROLL_AGENT_LOG_LEVEL` 环境变量读取(显式传入 > 环境变量 > 默认 `info`),便于在不改代码的情况下静默/调高子 Agent 日志。

## 0.2.0

### Minor Changes

- [#91](https://github.com/steveoon/roll-agent/pull/91) [`e84cba2`](https://github.com/steveoon/roll-agent/commit/e84cba281b5f5a999577175db296a48e843eeff9) Thanks [@steveoon](https://github.com/steveoon)! - Add browser security policy and browser-use tool confirmation policy.
  - Add env-driven browser hard boundaries for domain allowlists, action policy decisions, and output caps.
  - Add browser-use tool-level policy with one-time approval tokens for confirm-gated tools.
  - Gate `zhipin_send_prepared_reply` with non-consuming prepared reply inspection and approval retry support.
  - Add structured tool errors in the SDK and expose them through `roll run --json`.
  - Surface browser security and tool policy summaries in `browser_status` and `roll doctor`.

## 0.1.6

### Patch Changes

- [#65](https://github.com/steveoon/roll-agent/pull/65) [`256d676`](https://github.com/steveoon/roll-agent/commit/256d6765dfb451e7aca57121e304bfba54e56752) Thanks [@steveoon](https://github.com/steveoon)! - Preserve MCP `tools/list` input schemas for tools whose root Zod object is wrapped by refinements while still enforcing the original schema before execution.

## 0.1.5

### Patch Changes

- [#33](https://github.com/steveoon/roll-agent/pull/33) [`5661430`](https://github.com/steveoon/roll-agent/commit/5661430138b6e86d6025d209702271ad3d3cd793) Thanks [@steveoon](https://github.com/steveoon)! - build: bundle published packages into single JS files via esbuild

  Replace multi-file tsc output with esbuild single-file bundles to eliminate
  internal file structure from dist/. Build pipeline is now
  tsc --emitDeclarationOnly → esbuild bundle → terser minification.
  .d.ts files preserved as-is for TypeScript consumers.

## 0.1.4

### Patch Changes

- [#26](https://github.com/steveoon/roll-agent/pull/26) [`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c) Thanks [@steveoon](https://github.com/steveoon)! - build: add terser minification and remove source maps from published packages
  - Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
  - Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
  - Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
  - `.d.ts` files remain intact for TypeScript consumers

## 0.1.3

### Patch Changes

- [#21](https://github.com/steveoon/roll-agent/pull/21) [`6e92776`](https://github.com/steveoon/roll-agent/commit/6e9277676a9c9a654906f5d75f998de7033765ac) Thanks [@steveoon](https://github.com/steveoon)! - fix(deps): upgrade zod from ^3.25.0 to ^3.25.76

  zod@3.25.0 缺少 dist/ 目录，导致 tsc 和运行时均无法解析模块。锁定下限到 3.25.76 修复此问题。

## 0.1.2

### Patch Changes

- [#5](https://github.com/steveoon/roll-agent/pull/5) [`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e) Thanks [@steveoon](https://github.com/steveoon)! - Agent runtime management v1 and browser-use tools migration

  **@roll-agent/core**
  - Three-layer agent model: source / transport / runtime ownership
  - Store schema v2 with backward-compatible migration
  - package.json#rollAgent manifest support for agent discovery
  - PID-based process management for core-managed agents
  - CLI lifecycle commands: install/start/stop/health/update/remove
  - Argument extractor and extraction schema improvements
  - LLM router tool description fix

  **@roll-agent/browser-use-agent**
  - Migrate all 11 zhipin tools from ai-sdk-computer-use
  - Add chat-navigation helper with ensureChatOpen for single-shot mode
  - Anti-detection: randomDelay, humanDelay, scroll patterns
  - Fix DOM selectors for exchange-wechat, say-hello, get-candidate-list
  - Add navigate_active_tab tool
  - Publish as @roll-agent/browser-use-agent with rollAgent manifest

  **@roll-agent/browser**
  - Add page listing, selection, and navigation APIs to context-manager

  **@roll-agent/sdk**
  - HTTP transport shutdown order fix
