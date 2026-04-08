# smart-reply-agent

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
