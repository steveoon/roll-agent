# @roll-agent/reply-authority-client

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
