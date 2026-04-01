# @roll-agent/browser-use-agent

## 0.3.1

### Patch Changes

- [#26](https://github.com/steveoon/roll-agent/pull/26) [`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c) Thanks [@steveoon](https://github.com/steveoon)! - build: add terser minification and remove source maps from published packages
  - Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
  - Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
  - Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
  - `.d.ts` files remain intact for TypeScript consumers

- Updated dependencies [[`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c)]:
  - @roll-agent/sdk@0.1.4
  - @roll-agent/browser@0.1.4

## 0.3.0

### Minor Changes

- [#21](https://github.com/steveoon/roll-agent/pull/21) [`a6747b8`](https://github.com/steveoon/roll-agent/commit/a6747b8a1f3995246817054d36de120dd921e84e) Thanks [@steveoon](https://github.com/steveoon)! - refactor(browser-use): zhipin_get_username 升级为语义定位优先 + CSS 兜底的混合定位
  - 四策略证据收集：P1 语义角色（getByRole）+ P2 ARIA snapshot + P3 叶子文本 + P4 CSS 兜底
  - 纯函数打分择优，支持位置权重（xRatio）和跨策略交叉确认
  - 输出 schema 增量扩展：新增 usedStrategy/source 字段，保留 usedSelector 兼容
  - 抽取 platform-page.ts 复用平台页面查找逻辑
  - zhipin_get_username 现在仅复用当前 runtime 已跟踪的 BOSS直聘页面，不再对未跟踪页面做隐式扫描或副作用恢复；首次使用需先 open_platform，或通过 list_pages + select_page 恢复跟踪
  - 修复 username 长度判断 off-by-one（< 改回 <=）

### Patch Changes

- Updated dependencies [[`6e92776`](https://github.com/steveoon/roll-agent/commit/6e9277676a9c9a654906f5d75f998de7033765ac)]:
  - @roll-agent/sdk@0.1.3
  - @roll-agent/browser@0.1.3

## 0.2.2

### Patch Changes

- [#13](https://github.com/steveoon/roll-agent/pull/13) [`55e3417`](https://github.com/steveoon/roll-agent/commit/55e34178bcd18063ecc63b5fd7dc456d79e6baed) Thanks [@steveoon](https://github.com/steveoon)! - Fix the published `@roll-agent/browser` npm manifest to export `dist` files instead of `src` files, and republish `@roll-agent/browser-use-agent` against the fixed browser package.

- Updated dependencies [[`55e3417`](https://github.com/steveoon/roll-agent/commit/55e34178bcd18063ecc63b5fd7dc456d79e6baed)]:
  - @roll-agent/browser@0.1.2

## 0.2.1

### Patch Changes

- [#10](https://github.com/steveoon/roll-agent/pull/10) [`0d86a7c`](https://github.com/steveoon/roll-agent/commit/0d86a7cafc515be6d240377fdf21894ea072c4f3) Thanks [@steveoon](https://github.com/steveoon)! - Make browser-use-agent default to system Chrome without downloading Playwright Chromium during install.

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

### Patch Changes

- Updated dependencies [[`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e)]:
  - @roll-agent/browser@0.1.1
  - @roll-agent/sdk@0.1.2
