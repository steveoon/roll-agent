---
"@roll-agent/reply-authority-client": minor
"@roll-agent/browser-use-agent": minor
"@roll-agent/smart-reply-agent": patch
---

Adapt Reply Authority dual-draft `replyVariants` feedback loop.

- `@roll-agent/reply-authority-client` adds `replyVariants`, reply feedback body/response/rubric schemas, `fetchReplyFeedbackRubric()`, and `postReplyFeedback()`.
- `@roll-agent/browser-use-agent` stores dual-draft prepared replies behind neutral `option_1` / `option_2`, adds `zhipin_judge_prepared_reply`, supports `variantDecision` in `zhipin_send_prepared_reply`, and posts `/reply-feedback` after successful sends.
- `@roll-agent/browser-use-agent` also renders neutral dual-draft options side-by-side in the in-page reply preview so operators can compare the two safe alternatives before sending.
- `@roll-agent/browser-use-agent` normalizes Zhipin profile experience tokens: graduation labels such as `25年应届生` become `应届生`, graduation years such as `06年毕业` are excluded from work experience, implausible bare year values are dropped, and bare year labels strip leading zeros; Reply Authority `422` / `504` / `5xx` preview failures are classified as rejection, timeout, or server errors.
- `@roll-agent/smart-reply-agent` re-exports the new protocol schemas/types and documents that the primary browser send loop should use `browser-use`.
- Roll/OpenClaw orchestration docs now describe prepared artifacts, neutral variant choices, optional judge/decision stages, and confirmation retries without exposing signed envelopes.
