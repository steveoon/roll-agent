# @roll-agent/core

## 0.4.0

### Minor Changes

- [#39](https://github.com/steveoon/roll-agent/pull/39) [`69c0cec`](https://github.com/steveoon/roll-agent/commit/69c0cec9096cc4c5d43e2959fb6f9a6265d42d6e) Thanks [@steveoon](https://github.com/steveoon)! - feat: installed-package subagent 真实版本检测
  - `roll update --check` 对 installed-package 类型 Agent 做真实 npm 版本比较，不再固定显示 ⬆ 图标
  - 五分类版本状态：up-to-date(✅) / update-available(⬆) / pinned-behind(📌) / unsupported-spec(?) / unknown(?)
  - `InstalledAgentSource` 新增 `installedVersion` 字段，install/update 后自动记录
  - 版本查询结果按包名缓存（TTL 24h），不阻塞 CLI 命令
  - installed-package + core-managed Agent 升级顺序修正为 stop → install → restart

## 0.3.3

### Patch Changes

- [#30](https://github.com/steveoon/roll-agent/pull/30) [`d4409be`](https://github.com/steveoon/roll-agent/commit/d4409bec1ad398a28dcaac1edc481f4d89da317d) Thanks [@steveoon](https://github.com/steveoon)! - feat: auto-detect local dev agents and fallback to type-stripping

  When spawning on-demand stdio agents registered via `local-path` or `git`,
  automatically fall back from `node dist/index.js` to
  `node --experimental-strip-types src/index.ts` if the source file exists.
  This unifies the dev fallback behavior already available for `core-managed`
  agents (like browser-use) to also cover `on-demand` agents (like smart-reply).

## 0.3.2

### Patch Changes

- [#26](https://github.com/steveoon/roll-agent/pull/26) [`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c) Thanks [@steveoon](https://github.com/steveoon)! - build: add terser minification and remove source maps from published packages
  - Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
  - Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
  - Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
  - `.d.ts` files remain intact for TypeScript consumers

## 0.3.1

### Patch Changes

- [#21](https://github.com/steveoon/roll-agent/pull/21) [`6e92776`](https://github.com/steveoon/roll-agent/commit/6e9277676a9c9a654906f5d75f998de7033765ac) Thanks [@steveoon](https://github.com/steveoon)! - fix(deps): upgrade zod from ^3.25.0 to ^3.25.76

  zod@3.25.0 缺少 dist/ 目录，导致 tsc 和运行时均无法解析模块。锁定下限到 3.25.76 修复此问题。

## 0.3.0

### Minor Changes

- [#17](https://github.com/steveoon/roll-agent/pull/17) [`dd6fee8`](https://github.com/steveoon/roll-agent/commit/dd6fee846ca32421457b5c7c44b8f0370e7a52eb) Thanks [@steveoon](https://github.com/steveoon)! - Agent env declaration system, install safety, and config migration detection
  - Fix env placeholder detection: `${FOO}` values in agents.env are now
    correctly reported as "missing" instead of falsely passing checks
  - Fix tgz/tarball install: resolveInstalledPackageRoot 3-level fallback
    for non-standard package specs
  - Fix symlink safety: roll-env-file path check uses realpathSync
  - Add agent env declaration system: SKILL.md roll-env-file + env.yaml
    contract, inspectAgentEnvRequirements in doctor/add/install/info
  - agent-install rejects git URLs and local directories with guidance
  - doctor reports per-agent env status (ok/warn/fail)
  - Config migration detection in roll update and roll doctor

## 0.2.2

### Patch Changes

- [#15](https://github.com/steveoon/roll-agent/pull/15) [`04a1f9a`](https://github.com/steveoon/roll-agent/commit/04a1f9a17f18722ec958af89e0085714f10e8097) Thanks [@steveoon](https://github.com/steveoon)! - Switch the qwen provider integration to the official `@ai-sdk/alibaba` provider.
  This fixes `roll ask` / `roll run` compatibility when using DashScope Qwen models through the core LLM layer.

## 0.2.1

### Patch Changes

- [#10](https://github.com/steveoon/roll-agent/pull/10) [`0d86a7c`](https://github.com/steveoon/roll-agent/commit/0d86a7cafc515be6d240377fdf21894ea072c4f3) Thanks [@steveoon](https://github.com/steveoon)! - Improve breaking config schema handling by adding `roll config migrate`, stronger `roll update` migration reminders, `roll doctor` config compatibility reporting, and by ensuring deprecated `router` config does not block agent management commands that only need the local agent registry.

## 0.2.0

### Minor Changes

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
