# smart-reply-agent

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
