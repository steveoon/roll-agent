# smart-reply-agent

## 1.3.0

### Minor Changes

- [#112](https://github.com/steveoon/roll-agent/pull/112) [`1fe17c6`](https://github.com/steveoon/roll-agent/commit/1fe17c6f0fb342c5487d4e1e797e0e37c9392530) Thanks [@steveoon](https://github.com/steveoon)! - 新增候选人地点信号（`locationSignals`）管道，供 Reply Authority 生成更贴近门店/区域的回复（Issue [#111](https://github.com/steveoon/roll-agent/issues/111)）。
  - `@roll-agent/reply-authority-client`：新增 `CandidateLocationSignalSchema`，`GenerateReplyToolInput` 支持可选 `locationSignals`。
  - `@roll-agent/browser-use-agent`：`job-signals` 通过 LLM 明确区分地点咨询与非地点咨询，地点咨询时抽取原文地点证据，非地点咨询时返回空信号；LLM 失败时仅返回资料城市/区域弱信号；`zhipin_get_candidate_info` 与 `zhipin_generate_reply_preview` 透传 `locationSignals`，并在浏览器内展示地点分析/生成进度。
  - `@roll-agent/smart-reply-agent`：re-export 地点信号 schema，保持与 Reply Authority 契约一致。

### Patch Changes

- Updated dependencies [[`1fe17c6`](https://github.com/steveoon/roll-agent/commit/1fe17c6f0fb342c5487d4e1e797e0e37c9392530)]:
  - @roll-agent/reply-authority-client@0.2.0

## 1.2.5

### Patch Changes

- [#91](https://github.com/steveoon/roll-agent/pull/91) [`7ba7324`](https://github.com/steveoon/roll-agent/commit/7ba73245068d1340424ff5e27438201c560c4a2b) Thanks [@steveoon](https://github.com/steveoon)! - Add Reply Authority shared client, browser-use streaming reply preview, and prepared reply sending.

  Browser-use now streams Reply Authority progress into an in-page preview panel, stores signed replies
  behind opaque `preparedReplyId` values, and sends via `zhipin_send_prepared_reply` without exposing
  signed envelopes to callers. Sending reuses the currently selected chat when it already matches the
  prepared reply target, while still reopening and validating stale targets as a fallback. The preview
  panel also shows a lightweight loading spinner during generation.

  Smart-reply now reuses the shared Reply Authority client for the existing non-streaming
  `generate_reply` flow. The shared Reply Authority schema now accepts `modelConfig.reasoning`, so
  orchestrators can explicitly request reasoning/thinking mode for smart replies. Browser-use exposes
  the same choice as a narrow `reasoning` option on `zhipin_generate_reply_preview`, while preserving
  opaque prepared reply artifacts instead of passing signed envelopes through orchestrators.

- Updated dependencies [[`e84cba2`](https://github.com/steveoon/roll-agent/commit/e84cba281b5f5a999577175db296a48e843eeff9), [`7ba7324`](https://github.com/steveoon/roll-agent/commit/7ba73245068d1340424ff5e27438201c560c4a2b)]:
  - @roll-agent/sdk@0.2.0
  - @roll-agent/reply-authority-client@0.1.2

## 1.2.4

### Patch Changes

- [#89](https://github.com/steveoon/roll-agent/pull/89) [`a600efb`](https://github.com/steveoon/roll-agent/commit/a600efb3f3db513801fac22555e7abbc4342e936) Thanks [@steveoon](https://github.com/steveoon)! - Add Reply Authority shared client, browser-use streaming reply preview, and prepared reply sending.

  Browser-use now streams Reply Authority progress into an in-page preview panel, stores signed replies
  behind opaque `preparedReplyId` values, and sends via `zhipin_send_prepared_reply` without exposing
  signed envelopes to callers. Sending reuses the currently selected chat when it already matches the
  prepared reply target, while still reopening and validating stale targets as a fallback. The preview
  panel also shows a lightweight loading spinner during generation.

  Smart-reply now reuses the shared Reply Authority client for the existing non-streaming
  `generate_reply` flow. Roll/OpenClaw orchestration docs were updated to describe opaque prepared
  reply artifacts instead of passing signed envelopes through orchestrators.

- Updated dependencies [[`a600efb`](https://github.com/steveoon/roll-agent/commit/a600efb3f3db513801fac22555e7abbc4342e936)]:
  - @roll-agent/reply-authority-client@0.1.1

## 1.2.3

### Patch Changes

- Updated dependencies [[`256d676`](https://github.com/steveoon/roll-agent/commit/256d6765dfb451e7aca57121e304bfba54e56752)]:
  - @roll-agent/sdk@0.1.6

## 1.2.2

### Patch Changes

- [#60](https://github.com/steveoon/roll-agent/pull/60) [`1ed08f8`](https://github.com/steveoon/roll-agent/commit/1ed08f80de0dfdd5bb6d04622dbdd756b8df0a05) Thanks [@steveoon](https://github.com/steveoon)! - docs(smart-reply): clarify preferredBrand passthrough rules and diagnostics contract
  - SKILL.md 补充招聘场景调用约束：`preferredBrand` 仅在 `communicationPosition` 含连字符类分隔符时透传第一段，禁止用通用岗位名或候选人公司名填充
  - 明确 `diagnostics.brandResolutionSource="none"`、`resolvedBrand=""`、`ageGate.status="unknown"` 均为合法服务端结果，不是 tool 调用失败
  - 工作流步骤补充"调用前补齐页面信号"阶段，序号从 4 步更新为 6 步
  - 新增 reply-authority-client 测试：验证 preferredBrand 信号原样透传、通用岗位名不伪造品牌

## 1.2.1

### Patch Changes

- [#56](https://github.com/steveoon/roll-agent/pull/56) [`51a83d6`](https://github.com/steveoon/roll-agent/commit/51a83d62863d6f4a6eb7f0d142240b603065a6a0) Thanks [@steveoon](https://github.com/steveoon)! - feat(smart-reply): make Reply Authority HTTP timeout configurable via `REPLY_AUTHORITY_TIMEOUT_MS`
  - 新增可选环境变量 `REPLY_AUTHORITY_TIMEOUT_MS`，支持通过 `agents.env.smart-reply-agent` 注入，覆盖默认超时
  - 默认超时从 20_000ms 调整为 30_000ms（更贴近真实网络波动下 Reply Authority Service 的响应分布）
  - 严格解析：非正整数、含空白或科学记数法等非规范值会静默回落到默认，避免意外的短超时
  - `diagnostic_status` 诊断 tool 会返回该 env 的 `{present, fingerprint}`，`roll agent info` 据此展示 `未设置（使用默认值）` / `✓ from yaml (stable)` / `⚠ from shell (ephemeral)` 等漂移标签

## 1.2.0

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

## 1.1.0

### Minor Changes

- [#52](https://github.com/steveoon/roll-agent/pull/52) [`a73f10a`](https://github.com/steveoon/roll-agent/commit/a73f10ae62a591a4e8c66aef8336b211af0db68e) Thanks [@steveoon](https://github.com/steveoon)! - feat: add recruiter binding resolution and v2 envelope verification
  - smart-reply agent now accepts direct `recruiterBinding` or proxy `recruiterUsername`, resolving recruiter bindings before calling Reply Authority Service when needed
  - browser-use agent now expects v2 signed envelopes and validates recruiter binding before sending replies

## 1.0.0

### Major Changes

- [#47](https://github.com/steveoon/roll-agent/pull/47) [`3b47ef0`](https://github.com/steveoon/roll-agent/commit/3b47ef041d8361621300e28ac69d619bd3164edb) Thanks [@steveoon](https://github.com/steveoon)! - refactor(smart-reply): 移除本地回复管线和 sync_brand_data

  generate_reply 已全切 Reply Authority Service 云端签发，本地 pipeline 不再需要。

  BREAKING CHANGES:
  - 移除 `sync_brand_data` tool，品牌数据同步改由 reply-authority-service admin API 负责
  - 移除 `./pipeline` 公开导出（package.json#exports）
  - 移除 DULIDAY_TOKEN / DULIDAY_BRAND_LIST_URL / DULIDAY_JOB_LIST_URL 环境变量需求
  - 删除本地 pipeline/、ai/、errors/ 模块和 data/ 目录
  - 类型层收缩为最小 schema（CandidateInfoSchema、ModelConfigSchema、FunnelStageSchema）

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

## 0.4.0

### Minor Changes

- [#41](https://github.com/steveoon/roll-agent/pull/41) [`521c7c5`](https://github.com/steveoon/roll-agent/commit/521c7c5e138512f2c999d5563d372ddd0f07be8e) Thanks [@steveoon](https://github.com/steveoon)! - feat(smart-reply): generate_reply 输出新增 replyPolicySource 字段，透传回复策略来源（file/default）

## 0.3.0

### Minor Changes

- [#37](https://github.com/steveoon/roll-agent/pull/37) [`d273c16`](https://github.com/steveoon/roll-agent/commit/d273c1690b613fff76e53beadfdae0447e124c95) Thanks [@steveoon](https://github.com/steveoon)! - refactor: 重构 `age-eligibility` 为 source chain + 纯评估器

  Breaking change:
  - `evaluateAgeEligibility()` 不再读取 `process.env` 或直接请求 Duliday API
  - `evaluateAgeEligibility()` 改为同步纯评估函数，输入从旧的
    `{ age, brandAlias, cityName, regionName, strategy }`
    变为
    `{ age, evidence, matchedCount?, total?, isComplete?, strategy }`
  - 如需默认取证链，请改用
    `createDefaultAgeEligibilitySources()` + `collectAgeEvidenceFromSources()`

  兼容行为：
  - `generateSmartReply()` 未传 `ageEligibilitySources` 时，默认优先使用 `configData`
  - 仅当 `DULIDAY_TOKEN` 与 `DULIDAY_JOB_LIST_URL` 都存在时，才追加 Duliday API fallback
  - `summary.matchedCount/total` 保留为“过滤后命中数 / source 总数”语义

## 0.2.0

### Minor Changes

- [#35](https://github.com/steveoon/roll-agent/pull/35) [`8719dc6`](https://github.com/steveoon/roll-agent/commit/8719dc6dcc0c0d8ae3963afd063ee22ebdb58c03) Thanks [@steveoon](https://github.com/steveoon)! - refactor: 重构岗位数据同步，消除捏造兜底，透传接口原值

  Position Schema breaking change:
  - 删除 scheduleType/urgent/attendancePolicy/schedulingFlexibility/requirements 5 个推断字段
  - 新增 jobCategory/laborForm/employmentForm/trainingRequired/probationRequired/
    perMonthMinWorkTime/perMonthMinWorkTimeUnit/sourceJobName 等接口直出字段
  - 新增 socialIdentity（社会身份，来自 hiringRequirement.figure）
  - Benefits 改为直接透传接口原值，不再做语义判断
  - HiringRequirements 扩展 languages/certificatesRaw/recruitmentRemark/socialIdentity
  - salary.base/memo 改为 nullable，context-builder 使用 salary.unit 替代硬编码单位
  - combinedArrangement 解析兼容小写驼峰字符串时间格式
  - context-builder: schedule 消费 employmentForm，requirements 消费 socialIdentity

  变更后需重新执行 sync_brand_data 同步岗位数据。

## 0.1.3

### Patch Changes

- [#33](https://github.com/steveoon/roll-agent/pull/33) [`5661430`](https://github.com/steveoon/roll-agent/commit/5661430138b6e86d6025d209702271ad3d3cd793) Thanks [@steveoon](https://github.com/steveoon)! - build: bundle published packages into single JS files via esbuild

  Replace multi-file tsc output with esbuild single-file bundles to eliminate
  internal file structure from dist/. Build pipeline is now
  tsc --emitDeclarationOnly → esbuild bundle → terser minification.
  .d.ts files preserved as-is for TypeScript consumers.

- Updated dependencies [[`5661430`](https://github.com/steveoon/roll-agent/commit/5661430138b6e86d6025d209702271ad3d3cd793)]:
  - @roll-agent/sdk@0.1.5

## 0.1.2

### Patch Changes

- [#28](https://github.com/steveoon/roll-agent/pull/28) [`5bbcc8e`](https://github.com/steveoon/roll-agent/commit/5bbcc8e5a5dee102dab477bf5654281359ca9aba) Thanks [@steveoon](https://github.com/steveoon)! - fix: Anthropic structured output compatibility for planTurn
  - Strip unsupported JSON Schema keywords (`maxItems`, `maximum`, `minimum`, `exclusiveMaximum`, `exclusiveMinimum`) from output schema sent to Anthropic models
  - Add `normalizeGeneratedTurnPlanOutput` to clip over-limit arrays before strict Zod validation
  - Only triggered when `classifyModel` starts with `anthropic/`; other providers unaffected
  - Original strict schema remains the internal contract — compatibility layer only affects what is sent to the LLM

## 0.1.1

### Patch Changes

- [#26](https://github.com/steveoon/roll-agent/pull/26) [`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c) Thanks [@steveoon](https://github.com/steveoon)! - build: add terser minification and remove source maps from published packages
  - Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
  - Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
  - Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
  - `.d.ts` files remain intact for TypeScript consumers

- Updated dependencies [[`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c)]:
  - @roll-agent/sdk@0.1.4

## 0.1.0

### Minor Changes

- [#23](https://github.com/steveoon/roll-agent/pull/23) [`3f30c29`](https://github.com/steveoon/roll-agent/commit/3f30c2903017576c4fcc627e366b9e9253296760) Thanks [@steveoon](https://github.com/steveoon)! - feat(smart-reply): publish as public npm package with pipeline sub-path export
  - Rename from `smart-reply-agent` (private) to `@roll-agent/smart-reply-agent` (public)
  - Add `./pipeline` sub-path export exposing `generateSmartReply` and all related types
  - Add `rollAgent` manifest for stdio on-demand agent registration
  - Exclude test files from build output
  - Update SKILL.md with capability boundary, routing signals, and cross-agent workflow
  - Add `references/reply-policy-schema.md` documenting all configurable policy fields

## 0.0.2

### Patch Changes

- Updated dependencies [[`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e)]:
  - @roll-agent/sdk@0.1.2
