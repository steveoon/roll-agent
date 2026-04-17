# @roll-agent/core

## 0.5.2

### Patch Changes

- [#50](https://github.com/steveoon/roll-agent/pull/50) [`ac7bf45`](https://github.com/steveoon/roll-agent/commit/ac7bf45386ef74768a53f611c6821a58fa5b2f2b) Thanks [@steveoon](https://github.com/steveoon)! - refactor(core): 引入统一的 config key codec 消除 kebab↔camel 反复打补丁

  **根因**：loader 过去用递归 deep-transform 把 YAML 所有键统一转 camelCase，对 `agents.env` / `llm.providers` 这类 dynamic record 的用户键（agent 名、provider 名）也做了错误改写，导致 `roll config get` 输出与 YAML 原文不一致，`helpers.ts` 需要 camelCase 兜底，`config set` 需要 SCREAMING*SNAKE_CASE 特判绕开把 `REPLY_AUTHORITY_URL` 打成 `-r-e-p-l-y*-...`。过去两次都是下游打补丁，没修到病灶。

  **改动**：
  - 新增 `config/key-codec.ts`：显式 codec tree 声明哪些节点是 schema 固定字段（kebab↔camel 转换），哪些是 dynamic record（键原样保留）。导出 `decodeFromYaml` / `encodePathToYaml` / `normalizeUserPath` 供 loader / `config set` / `config get` 使用。
  - `loader.ts` 的 `kebabToCamelDeep` 改走 `decodeFromYaml`，删除 `DYNAMIC_RECORD_PATHS` 硬编码白名单。
  - `config set` 的 `camelToKebab` 替换为 `encodePathToYaml`，删除 SCREAMING_SNAKE_CASE 特判。
  - `config get` 接入 `normalizeUserPath`，用户输 kebab 或 camel 路径均可命中 schema 字段；record 键保持原样查找。
  - `helpers.ts` 的 `getAgentEnvFromMap` 删除 camelCase 兜底，只保留 exact match。
  - `migration.ts` 新增 `legacy-agent-env-keys` 规则：存量 non-canonical agent 名（`smartReplyAgent`、`smart-Reply-agent`、`smart_reply_agent` 等）在 `loadConfig` 阶段报错并引导 `roll config migrate`；可安全 `camelToKebab` 的自动改名，mixed-case / 含非法字符 / 与 kebab 版本同存的情况视为 blocking 要求手动处理。
  - `migration.ts` 引入 `ConfigMigrationScope`（`"llm" | "ask" | "agents"`），每条规则标注 scopes；`detectKnownConfigMigrations` 支持按 scope 过滤。`loadAgentsConfig` 只跑 `scope=agents` 规则，避免 router-to-ask 误伤 `agent list` / `doctor` 等命令在仅 router 段 legacy 时的降级可用性；`loadConfig` 跑全量规则。两者共用 `parseAndCheckMigrations` helper，补上此前 `loadAgentsConfig` 绕过 migration 检测的旁路。

  所有 read / write / lookup 路径现在都经过同一个 codec 作为唯一真相源；`roll config init` / `get` / `set` / `migrate` 四个子命令语义对齐。

## 0.5.1

### Patch Changes

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

## 0.5.0

### Minor Changes

- [#41](https://github.com/steveoon/roll-agent/pull/41) [`c52f598`](https://github.com/steveoon/roll-agent/commit/c52f59849b1f26731c28ce1af261779741f3b671) Thanks [@steveoon](https://github.com/steveoon)! - feat(core): qwen provider structured output 兼容性增强
  - 新增 resolveLLMCall()，qwen + structured-output 场景自动注入 enableThinking: false
  - LLM 路由新增 text fallback，模型不遵循 json_schema 时降级为纯文本 + JSON.parse
  - 升级 AI SDK 全线依赖至最新版本

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
