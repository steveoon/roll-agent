# @roll-agent/browser

## 0.7.0

### Minor Changes

- [#100](https://github.com/steveoon/roll-agent/pull/100) [`fd4917d`](https://github.com/steveoon/roll-agent/commit/fd4917d6720fd76a4b8a4f1e466ca3fa6d7ecc26) Thanks [@steveoon](https://github.com/steveoon)! - Add managed multi-browser instance support with per-instance runtime config, status reporting, profile labeling, and adaptive visible window tiling for browser-use workflows.

## 0.6.0

### Minor Changes

- [#98](https://github.com/steveoon/roll-agent/pull/98) [`1431557`](https://github.com/steveoon/roll-agent/commit/14315578effb9f8f2f035b5225b9f4904ffd7fe7) Thanks [@steveoon](https://github.com/steveoon)! - Add browser foreground policy control for native CDP interactions.

  Browser security config now supports `foregroundPolicy` with a default of `when-minimized`, so native browser actions only call `Page.bringToFront` when the target Chrome window is minimized. `browser-use-agent` applies the policy across generic ref actions and Zhipin native tools, and browser diagnostics now report the effective policy.

## 0.5.0

### Minor Changes

- [#94](https://github.com/steveoon/roll-agent/pull/94) [`2013aea`](https://github.com/steveoon/roll-agent/commit/2013aeada6d7269826133ed0e6c1e765d06a70b7) Thanks [@steveoon](https://github.com/steveoon)! - Add generic browser Accessibility snapshots and stable `@eN` element refs.
  - Add AX snapshot schemas, `Accessibility.getFullAXTree` support, and `@eN` ref generation in `@roll-agent/browser`.
  - Add backendNodeId-first element ref actions with role/name/nth fallback for stale refs, including recursive same-target iframe refs that carry `frameId`.
  - Promote non-semantic DOM-action controls inside same-target iframes, such as visible `div`/`span` buttons with `cursor:pointer` or button-like class hints.
  - Promote composite dropdown option rows by reading visible descendant text in dropdown/menu/select contexts.
  - Expose `browser_snapshot`, `click_ref`, and `type_ref` in `browser-use-agent`, capped by `security.maxSnapshotNodes` and gated by browser action policy.

## 0.4.0

### Minor Changes

- [#91](https://github.com/steveoon/roll-agent/pull/91) [`e84cba2`](https://github.com/steveoon/roll-agent/commit/e84cba281b5f5a999577175db296a48e843eeff9) Thanks [@steveoon](https://github.com/steveoon)! - Add browser security policy and browser-use tool confirmation policy.
  - Add env-driven browser hard boundaries for domain allowlists, action policy decisions, and output caps.
  - Add browser-use tool-level policy with one-time approval tokens for confirm-gated tools.
  - Gate `zhipin_send_prepared_reply` with non-consuming prepared reply inspection and approval retry support.
  - Add structured tool errors in the SDK and expose them through `roll run --json`.
  - Surface browser security and tool policy summaries in `browser_status` and `roll doctor`.

## 0.3.1

### Patch Changes

- [#82](https://github.com/steveoon/roll-agent/pull/82) [`2003604`](https://github.com/steveoon/roll-agent/commit/20036040a3a29cabc9022d6a34d092f4f908d4a7) Thanks [@steveoon](https://github.com/steveoon)! - Add native CDP page navigation support and move `navigate_active_tab` onto the native CDP path. The tool now avoids Playwright attach, reuses native platform tabs, opens non-platform URLs in a native page, and blocks direct BOSS `/web/chat/*` backend navigation in favor of semantic BOSS navigation tools.

## 0.3.0

### Minor Changes

- [#69](https://github.com/steveoon/roll-agent/pull/69) [`2da5f7f`](https://github.com/steveoon/roll-agent/commit/2da5f7f3a1c0bf3a473260c22297ff0e9d2acbcd) Thanks [@steveoon](https://github.com/steveoon)! - Add native CDP primitives and migrate the BOSS Zhipin main workflow to the native backend.

  `@roll-agent/browser` now exposes native CDP controller utilities for page inspection,
  DOM evaluation, mouse input, keyboard input, text insertion, and native locators without
  requiring a Playwright page attach.

  `browser-use-agent` now routes the BOSS Zhipin chat, reply sending, WeChat exchange,
  recommend-list reading, filtering, scrolling, and greet flows through the native backend.
  The remaining resume popup tools stay Playwright-backed and share their DOM contract through
  `resume-dom-contract.ts`.

  `roll ask` preflight validation now catches array `minItems` constraints before dispatching
  tool calls, so underspecified semantic requests can return `needs_input` instead of reaching
  MCP tool validation.

## 0.2.0

### Minor Changes

- [#41](https://github.com/steveoon/roll-agent/pull/41) [`1e317e0`](https://github.com/steveoon/roll-agent/commit/1e317e0807bdbbbc241e9f40632c7797fab1773c) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser): lazy Playwright attach + 原生 CDP 页面管理

  解决 Boss 直聘反自动化检测问题。根因：Playwright 在登录前持续 attach 整个浏览器 + newPage/goto 开页被 Boss 风控识别为自动化行为。

  **@roll-agent/browser 改动：**
  - BrowserRuntime 启动后不再立即 connectOverCDP()，改为首次 getBrowser() 时 lazy attach
  - 新增 NativeCdpPageClient，通过原生 CDP HTTP 接口（/json/list、/json/new、/json/activate）管理页面，全程不触发 Playwright
  - ContextManager 支持双轨状态：登录前 nativeSelection + 登录后 Playwright Page，attach 时启发式匹配回之前选中的 tab
  - 新增 profile 装饰（名称/颜色/clean exit 标记），Chrome 启动参数对齐 OpenClaw
  - DI 模式支持测试注入 spawn/connectOverCDP/fetch

  **@roll-agent/browser-use-agent 改动：**
  - open_platform / list_pages / select_page 全部切到原生 CDP 路径，登录前零 Playwright attach
  - 新增 attach_browser_session 调试工具，显式触发 connectOverCDP
  - 聊天页进入策略重构为四级 fallback：已是聊天页 → 复用已有聊天 tab → UI 点击消息按钮 → goto 兜底（软失败）
  - 所有 zhipin\_\* 工具内联的 page.goto 已清除，统一到 chat-navigation 辅助函数

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

- [#13](https://github.com/steveoon/roll-agent/pull/13) [`55e3417`](https://github.com/steveoon/roll-agent/commit/55e34178bcd18063ecc63b5fd7dc456d79e6baed) Thanks [@steveoon](https://github.com/steveoon)! - Fix the published `@roll-agent/browser` npm manifest to export `dist` files instead of `src` files, and republish `@roll-agent/browser-use-agent` against the fixed browser package.

## 0.1.1

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
