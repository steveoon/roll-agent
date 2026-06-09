---
"@roll-agent/reply-authority-client": minor
"@roll-agent/browser-use-agent": minor
"@roll-agent/smart-reply-agent": minor
---

新增候选人地点信号（`locationSignals`）管道，供 Reply Authority 生成更贴近门店/区域的回复（Issue #111）。

- `@roll-agent/reply-authority-client`：新增 `CandidateLocationSignalSchema`，`GenerateReplyToolInput` 支持可选 `locationSignals`。
- `@roll-agent/browser-use-agent`：`job-signals` 通过 LLM 抽取 + 证据校验 + 规则 fallback 解析地点；`zhipin_get_candidate_info` 与 `zhipin_generate_reply_preview` 透传 `locationSignals`；多轮对话扫描全部候选人消息，避免历史地点被最新消息覆盖丢失。
- `@roll-agent/smart-reply-agent`：re-export 地点信号 schema，保持与 Reply Authority 契约一致。
