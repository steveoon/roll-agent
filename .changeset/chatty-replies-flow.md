---
"@roll-agent/browser-use-agent": minor
"@roll-agent/reply-authority-client": patch
"@roll-agent/smart-reply-agent": patch
---

Add Reply Authority shared client, browser-use streaming reply preview, and prepared reply sending.

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
