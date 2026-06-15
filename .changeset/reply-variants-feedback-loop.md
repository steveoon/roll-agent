---
"@roll-agent/reply-authority-client": minor
"@roll-agent/browser-use-agent": minor
"@roll-agent/smart-reply-agent": patch
---

Adapt Reply Authority dual-draft `replyVariants` feedback loop.

- `@roll-agent/reply-authority-client` adds `replyVariants`, reply feedback body/response/rubric schemas, `fetchReplyFeedbackRubric()`, and `postReplyFeedback()`.
- `@roll-agent/browser-use-agent` stores dual-draft prepared replies behind neutral `option_1` / `option_2`, adds `zhipin_judge_prepared_reply`, supports `variantDecision` in `zhipin_send_prepared_reply`, and posts `/reply-feedback` after successful sends.
- `@roll-agent/smart-reply-agent` re-exports the new protocol schemas/types and documents that the primary browser send loop should use `browser-use`.
- Roll/OpenClaw orchestration docs now describe prepared artifacts, neutral variant choices, optional judge/decision stages, and confirmation retries without exposing signed envelopes.
