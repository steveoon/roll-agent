# @roll-agent/reply-authority-client

## 0.7.0

### Minor Changes

- [#152](https://github.com/steveoon/roll-agent/pull/152) [`63cba26`](https://github.com/steveoon/roll-agent/commit/63cba264d29978662461cd6c3be3dec7af333318) Thanks [@steveoon](https://github.com/steveoon)! - Preserve redacted request/phase/latency diagnostics when `zhipin_generate_reply_preview` fails (including `clientTimeoutMs` for the Roll transport budget), raise the shared Reply Authority client timeout default from 30s to 60s so it stays above the RFC complete-request deadline, and declare `REPLY_AUTHORITY_TIMEOUT_MS` in browser-use env diagnostics.

## 0.6.0

### Minor Changes

- [#150](https://github.com/steveoon/roll-agent/pull/150) [`6515fc2`](https://github.com/steveoon/roll-agent/commit/6515fc24aaddfb866a60b0ed3275d814467cc989) Thanks [@steveoon](https://github.com/steveoon)! - Enforce dual-draft judging at the prepared-reply send boundary for both roll chat and the unread-reply skill, enrich Judge decisions with bounded redacted context and concrete reasons, preserve preview-degraded groups as non-learning terminal outcomes, replace cross-service raw errors with stable safe reason codes, honor the service feedback deadline, persist feedback in a retryable SQLite outbox before posting it to Reply Authority, and sync browser-use SKILL/workflow docs for the new send-owned Judge and not_learned feedback path.

## 0.5.0

### Minor Changes

- [#118](https://github.com/steveoon/roll-agent/pull/118) [`becaaeb`](https://github.com/steveoon/roll-agent/commit/becaaeb479a65a96b93d62cc8b2326ea9aaa000e) Thanks [@steveoon](https://github.com/steveoon)! - Adapt Reply Authority dual-draft `replyVariants` feedback loop.
  - `@roll-agent/reply-authority-client` adds `replyVariants`, reply feedback body/response/rubric schemas, `fetchReplyFeedbackRubric()`, and `postReplyFeedback()`.
  - `@roll-agent/browser-use-agent` stores dual-draft prepared replies behind neutral `option_1` / `option_2`, adds `zhipin_judge_prepared_reply`, supports `variantDecision` in `zhipin_send_prepared_reply`, and posts `/reply-feedback` after successful sends.
  - `@roll-agent/browser-use-agent` also renders neutral dual-draft options side-by-side in the in-page reply preview so operators can compare the two safe alternatives before sending.
  - `@roll-agent/browser-use-agent` normalizes Zhipin profile experience tokens: graduation labels such as `25年应届生` become `应届生`, graduation years such as `06年毕业` are excluded from work experience, implausible bare year values are dropped, and bare year labels strip leading zeros; Reply Authority `422` / `504` / `5xx` preview failures are classified as rejection, timeout, or server errors.
  - `@roll-agent/smart-reply-agent` re-exports the new protocol schemas/types and documents that the primary browser send loop should use `browser-use`.
  - Roll/OpenClaw orchestration docs now describe prepared artifacts, neutral variant choices, optional judge/decision stages, and confirmation retries without exposing signed envelopes.

## 0.4.0

### Minor Changes

- [#116](https://github.com/steveoon/roll-agent/pull/116) [`a806ae7`](https://github.com/steveoon/roll-agent/commit/a806ae756b61f38912d0ce3dc4764dd3b9dfb8ba) Thanks [@steveoon](https://github.com/steveoon)! - 支持沟通职位新命名规范 `xxx-xxx-xxx[品牌ID]` 的品牌识别。
  - `resolvePreferredBrandId()`：从沟通职位末尾的 `[品牌ID]` 尾缀（兼容全角括号 `【】`/`［］` 与内部空白）提取 Duliday 品牌 ID
  - `resolvePreferredBrand()`：检测到品牌 ID 尾缀时不再取第一段作为品牌名，避免向服务端发送错误的 explicit 品牌信号（新格式第一段是岗位描述而非品牌名）
  - 协议新增可选字段 `preferredBrandId`，随 generate-reply / prepare-reply-context 请求发送，与 Reply Authority 服务端的 `duliday_id` 直查对齐；`zhipin_get_candidate_info` 输出同步暴露该字段（与 `preferredBrand` 互斥）
  - 老命名 `品牌名-xxx`（无 ID 尾缀）走原有名称解析链路，行为不变
  - 清理 location signal 本地 LLM 解析残留：地点证据提取已收编 Reply Authority 服务端，`job-signals.ts` 仅保留纯函数信号解析

## 0.3.0

### Minor Changes

- [#114](https://github.com/steveoon/roll-agent/pull/114) [`d40bc83`](https://github.com/steveoon/roll-agent/commit/d40bc835be0defdfa0068623534c7831c16c5ee6) Thanks [@steveoon](https://github.com/steveoon)! - Default Zhipin reply generation to Reply Authority server-side planning, consume server
  location-resolution stream events, and add a prepare-reply-context client API for speculative
  context preheating. Zhipin reply previews now surface timing details from stream phase latency
  events so prepared-context hits are visible in the browser feedback layer.

  `ReplyAuthorityRequestError` now exposes the HTTP `statusCode`, and `zhipin_get_candidate_info`
  backs off prepare attempts for 10 minutes after persistent failures (tenant prepare disabled or
  missing client env) instead of re-issuing doomed requests on every call. Its `locationSignals`
  output field is deprecated and always empty now that extraction lives server-side.

  `zhipin_generate_reply_preview` now consumes `gate.completed` events: when a server-side
  fact/quality gate rewrote the final reply, the browser completion label appends
  「终稿经安全门调整」 and the tool output includes `gateRewritten: true`, explaining why the
  final reply may differ from the streamed draft.

## 0.2.0

### Minor Changes

- [#112](https://github.com/steveoon/roll-agent/pull/112) [`1fe17c6`](https://github.com/steveoon/roll-agent/commit/1fe17c6f0fb342c5487d4e1e797e0e37c9392530) Thanks [@steveoon](https://github.com/steveoon)! - 新增候选人地点信号（`locationSignals`）管道，供 Reply Authority 生成更贴近门店/区域的回复（Issue [#111](https://github.com/steveoon/roll-agent/issues/111)）。
  - `@roll-agent/reply-authority-client`：新增 `CandidateLocationSignalSchema`，`GenerateReplyToolInput` 支持可选 `locationSignals`。
  - `@roll-agent/browser-use-agent`：`job-signals` 通过 LLM 明确区分地点咨询与非地点咨询，地点咨询时抽取原文地点证据，非地点咨询时返回空信号；LLM 失败时仅返回资料城市/区域弱信号；`zhipin_get_candidate_info` 与 `zhipin_generate_reply_preview` 透传 `locationSignals`，并在浏览器内展示地点分析/生成进度。
  - `@roll-agent/smart-reply-agent`：re-export 地点信号 schema，保持与 Reply Authority 契约一致。

## 0.1.2

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

## 0.1.1

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
