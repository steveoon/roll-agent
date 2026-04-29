# @roll-agent/browser-use-agent

## 0.7.7

### Patch Changes

- [#71](https://github.com/steveoon/roll-agent/pull/71) [`203e573`](https://github.com/steveoon/roll-agent/commit/203e5739477f6ad59180d8bfc9eec59ff3318d30) Thanks [@steveoon](https://github.com/steveoon)! - Slow down native CDP mouse movement previews and make click pulses more visible.

## 0.7.6

### Patch Changes

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

- Updated dependencies [[`2da5f7f`](https://github.com/steveoon/roll-agent/commit/2da5f7f3a1c0bf3a473260c22297ff0e9d2acbcd)]:
  - @roll-agent/browser@0.3.0

## 0.7.5

### Patch Changes

- [#67](https://github.com/steveoon/roll-agent/pull/67) [`4d11426`](https://github.com/steveoon/roll-agent/commit/4d11426060071f4c1dfceaa5019f4a397d332677) Thanks [@steveoon](https://github.com/steveoon)! - Fix `roll run` JSON object input handling and add browser-use diagnostics for BOSS page attach state.

  `roll run` now accepts a third positional JSON object as explicit tool input while keeping
  `--input-json` as the recommended orchestration-safe form. `browser-use-agent` also adds
  `zhipin_diagnose_browser_state` for inspecting BOSS native page selection, attach state, page
  readiness, and automation fingerprint exposure.

## 0.7.4

### Patch Changes

- Updated dependencies [[`256d676`](https://github.com/steveoon/roll-agent/commit/256d6765dfb451e7aca57121e304bfba54e56752)]:
  - @roll-agent/sdk@0.1.6

## 0.7.3

### Patch Changes

- [#63](https://github.com/steveoon/roll-agent/pull/63) [`e0f5a51`](https://github.com/steveoon/roll-agent/commit/e0f5a51b5e63e1503d906f4124a7209010688c92) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser-use): add dynamic list scrolling, recommend filter tool, and harden exchange-wechat
  - 新增 `zhipin_scroll_view(surface, direction?, steps?, distance?, settleMs?)`，支持 `chat-list` / `chat-history` / `recommend-list` 三个内部滚动容器；不传 `direction` 时使用该 surface 的默认方向
  - `zhipin_read_messages` 新增 `autoScroll` / `maxScrolls` 参数，默认按 `conversationId` 自动向下滚动左侧消息列表并合并去重
  - `zhipin_get_candidate_list` 新增 `autoScroll` / `maxScrolls` 参数和 `scrollStats.stopReason` 返回字段（`target-count` / `boundary` / `no-new-items` / `max-steps`），默认按 `candidateId` / `data-geek` 滚动去重
  - 抽出通用动态列表滚动器 `pages/shared/dynamic-list-scroller.ts` 和 `pages/zhipin/list-surfaces.ts`，由上述工具复用
  - 新增 `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)`，在「推荐牛人」页打开筛选面板，只设置年龄、性别、活跃度[单选] 三个维度并提交；未传的维度会重置为「不限」（年龄默认 `16-不限`），不会触碰岗位、学历、薪资、求职状态等其他筛选项
  - `zhipin_exchange_wechat` 可靠性加固：调用前用 `getSelectedChatTarget` / `getActiveChatPanel` 校验左侧选中会话与右侧聊天面板的候选人一致；「换微信」按钮 selector 限定在右侧 `.conversation-operate` 操作区，文本匹配从 `includes("换微信")` 改为严格等于，避免误匹配顶部筛选栏的「已交换微信」；移除全量 `span` 文本 fallback；marker 属性提取为常量并在 `finally` 中清理，避免跨调用残留
  - SKILL.md 更新推荐列表链路为 4 步，并补充动态列表滚动规则与 `index` 不可跨调用稳定的说明

## 0.7.2

### Patch Changes

- [#61](https://github.com/steveoon/roll-agent/pull/61) [`d4df6ee`](https://github.com/steveoon/roll-agent/commit/d4df6eebd70ee11be8d5c727777c5dd177b455af) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser-use): add semantic navigation tools, visual activity system, and stable conversation IDs
  - 新增 `navigate_active_tab`、`zhipin_open_chat_page`、`zhipin_open_recommend_page` 三个语义导航 tool，替代硬编码 URL 跳转
  - 引入 visual activity session 系统：cursor 生命周期与 activity tone 独立管理，支持从 theme key 派生色调
  - `browser_status` tool 重构视觉反馈输出，cursor 显示与活动状态解耦
  - BOSS 聊天工作流（read-messages、send-reply、open-chat、exchange-wechat 等）引入稳定 conversation ID，确保跨调用会话一致性

## 0.7.1

### Patch Changes

- [#58](https://github.com/steveoon/roll-agent/pull/58) [`8a0dd50`](https://github.com/steveoon/roll-agent/commit/8a0dd50253cd452b3651950e69aa2d6a1b1ce20a) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser-use): replace brand whitelist with hyphen-format preferredBrand extraction
  - `zhipin_get_candidate_info` 现在通过连字符类分隔符（`-` / `－` / `—` / `–`）从 `communicationPosition` 提取 `preferredBrand`，不再依赖硬编码白名单
  - 提取结果作为可选字段透传给 `generate_reply`，供 smart-reply-agent 做品牌锁定
  - 新增 `resolvePreferredBrand()` / `resolveExpectedSignals()` 纯函数，`resolveConversationSignals()` 统一出口
  - 移除 `BRAND_ALIAS_TO_NAME` 白名单和空格兼容分隔符逻辑

## 0.7.0

### Minor Changes

- [#54](https://github.com/steveoon/roll-agent/pull/54) [`edded04`](https://github.com/steveoon/roll-agent/commit/edded043c69b9e83af25b3f6e6dbb49c22332b08) Thanks [@steveoon](https://github.com/steveoon)! - feat: external-agent friendly discoverability, drift detection and error context

  面向 orchestrator / 外部 agent 的一轮可用性优化，覆盖最常踩的 4 个坑：
  - **Tool discoverability**
    - core 新增 `roll agent tools <agent-name>` 命令（含 `--json`），代理 MCP `tools/list`，输出每个 tool 的 name / description / inputSchema
    - `roll run` / `roll ask` 调到不存在的 tool 时，输出 Levenshtein + token overlap 融合评分的 "Did you mean: ..." 候选 + 指向 `roll agent tools` 的提示
  - **Unified preflight output**
    - core 新增 `packages/core/src/tool-runtime/preflight.ts` 模块，一次性聚合缺失字段（递归展开父对象 → 叶子字段）
    - 错误输出分 A（输入缺失）/ B（运行条件缺失）双 section，不再按 zod 首错截断
    - `roll ask` 的 `needs_input` 响应新增 `runtimeIssues` 字段
  - **Config drift detection**
    - browser-use 新增 `diagnostic_status` 诊断能力（经 `browser_status.effectiveEnvSources` 暴露），smart-reply 新增 `diagnostic_status` tool；两者返回声明过的 env key 的 `{present, fingerprint}`（SHA256 前 8 位，不泄漏 value）
    - core 的 `roll doctor` / `roll agent info` 调用诊断 tool，对比 yaml 声明与 agent 运行态指纹，展示 `✓ from yaml (stable)` / `⚠ differs from yaml (ephemeral)` / `⚠ from shell (ephemeral)` / `✗ missing` 等六态
  - **Fail-fast on preload + error context**
    - browser-use 启动期 preload Reply Authority 公钥失败时写入 `replyAuthorityKeysLoaded=false`，`browser_status` 输出该字段，`zhipin_send_reply` 在验签前就前置拒绝并返回结构化错误
    - smart-reply 的 Reply Authority 调用统一走 `ReplyAuthorityRequestError`（携带 `meta: {url, timeoutMs, requestId}` + `Error.cause` 链 + `x-request-id` 透传）

## 0.6.0

### Minor Changes

- [#52](https://github.com/steveoon/roll-agent/pull/52) [`a73f10a`](https://github.com/steveoon/roll-agent/commit/a73f10ae62a591a4e8c66aef8336b211af0db68e) Thanks [@steveoon](https://github.com/steveoon)! - feat: add recruiter binding resolution and v2 envelope verification
  - smart-reply agent now accepts direct `recruiterBinding` or proxy `recruiterUsername`, resolving recruiter bindings before calling Reply Authority Service when needed
  - browser-use agent now expects v2 signed envelopes and validates recruiter binding before sending replies

## 0.5.0

### Minor Changes

- [#47](https://github.com/steveoon/roll-agent/pull/47) [`289dc16`](https://github.com/steveoon/roll-agent/commit/289dc1660ec2d1c2973e024454a3192cef6f812e) Thanks [@steveoon](https://github.com/steveoon)! - feat(smart-reply): generate_reply 全切 Reply Authority Service 云端签发

  smart-reply-agent 不再本地执行回复管线，改为向 Reply Authority Service 转发请求。
  输入新增必填 target（platform/tenantId/conversationId/candidateId），
  输出新增 signedEnvelope 和 envelopeExp。
  环境变量：REPLY_AUTHORITY_URL + REPLY_AUTHORITY_BEARER_TOKEN。

  feat(browser-use): zhipin_send_reply 实现本地 Ed25519 信封验签

  输入从 message 改为 signedEnvelope，发送前执行完整验证链路：
  Ed25519 签名校验 → iss/aud/platform 校验 → exp/iat 时间戳校验 →
  jti 防重放 → conversationId/candidateId 目标绑定校验。
  zhipin_read_messages 和 zhipin_get_candidate_info 输出补充 conversationId/candidateId。

  fix(core): agent-start 未注入 agents.env 到 core-managed 进程

  roll agent start 启动 core-managed agent 时未传递 agents.env 配置的环境变量，
  改为通过 getAgentEnv() 查找并注入。

  fix(core): config set 错误转换 SCREAMING_SNAKE_CASE 键名

  camelToKebab 对全大写+下划线格式的环境变量名（如 REPLY_AUTHORITY_KEYS_URL）
  逐字符插入连字符，现跳过此类键名。

## 0.4.2

### Patch Changes

- [#43](https://github.com/steveoon/roll-agent/pull/43) [`a8cafd5`](https://github.com/steveoon/roll-agent/commit/a8cafd5eef20b104931614d14be280d2d84c343c) Thanks [@steveoon](https://github.com/steveoon)! - fix(browser-use): 推荐列表工具消除合成点击 isTrusted: false 风控风险

  zhipin_say_hello 和 zhipin_open_resume 的点击操作从 evaluate() 内合成 MouseEvent 改为 Playwright locator.click()，生成 isTrusted: true 事件，降低 Boss 直聘动作级反自动化检测风险。
  - 新增 recommend-list.ts 公共 helper，统一推荐列表的 frame 定位、列表等待、卡片信息只读提取
  - zhipin_say_hello: 移除 dispatchEvent(mousedown/mouseup/click) + btn.click()，改为 locator.scrollIntoViewIfNeeded() → hover() → humanDelay() → click()
  - zhipin_open_resume: 移除 evaluate 内 item.click()，改为 locator 定位 clickSurface → hover() → randomDelay() → click()
  - 保留原有时序随机化逻辑（humanDelay、performRandomScroll）
  - zhipin_get_username: 修复 lazy attach 后因 hasContext 前置检查导致的"未找到已跟踪页面"回归，改为 getPage() 自动发现并绑定页面
  - zhipin_send_reply: 发送按钮点击从 evaluate 内 btn.click() 改为 Playwright locator.click()，data-roll-send-btn 清理移入 finally 防残留
  - chat-navigation: clickMessageEntry() 和 clickChatItem() 从 evaluate 内 DOM click 改为临时 marker + Playwright locator.click()，新增 clearTemporaryMarker/clickMarkedElement 共用 helper

## 0.4.1

### Patch Changes

- [#43](https://github.com/steveoon/roll-agent/pull/43) [`a8cafd5`](https://github.com/steveoon/roll-agent/commit/a8cafd5eef20b104931614d14be280d2d84c343c) Thanks [@steveoon](https://github.com/steveoon)! - fix(browser-use): 推荐列表工具消除合成点击 isTrusted: false 风控风险

  zhipin_say_hello 和 zhipin_open_resume 的点击操作从 evaluate() 内合成 MouseEvent 改为 Playwright locator.click()，生成 isTrusted: true 事件，降低 Boss 直聘动作级反自动化检测风险。
  - 新增 recommend-list.ts 公共 helper，统一推荐列表的 frame 定位、列表等待、卡片信息只读提取
  - zhipin_say_hello: 移除 dispatchEvent(mousedown/mouseup/click) + btn.click()，改为 locator.scrollIntoViewIfNeeded() → hover() → humanDelay() → click()
  - zhipin_open_resume: 移除 evaluate 内 item.click()，改为 locator 定位 clickSurface → hover() → randomDelay() → click()
  - 保留原有时序随机化逻辑（humanDelay、performRandomScroll）

## 0.4.0

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

### Patch Changes

- Updated dependencies [[`1e317e0`](https://github.com/steveoon/roll-agent/commit/1e317e0807bdbbbc241e9f40632c7797fab1773c)]:
  - @roll-agent/browser@0.2.0

## 0.3.2

### Patch Changes

- [#33](https://github.com/steveoon/roll-agent/pull/33) [`5661430`](https://github.com/steveoon/roll-agent/commit/5661430138b6e86d6025d209702271ad3d3cd793) Thanks [@steveoon](https://github.com/steveoon)! - build: bundle published packages into single JS files via esbuild

  Replace multi-file tsc output with esbuild single-file bundles to eliminate
  internal file structure from dist/. Build pipeline is now
  tsc --emitDeclarationOnly → esbuild bundle → terser minification.
  .d.ts files preserved as-is for TypeScript consumers.

- Updated dependencies [[`5661430`](https://github.com/steveoon/roll-agent/commit/5661430138b6e86d6025d209702271ad3d3cd793)]:
  - @roll-agent/sdk@0.1.5
  - @roll-agent/browser@0.1.5

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
