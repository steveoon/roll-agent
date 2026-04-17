---
"@roll-agent/smart-reply-agent": minor
"@roll-agent/browser-use-agent": minor
---

feat: add recruiter binding resolution and v2 envelope verification

- smart-reply agent now accepts direct `recruiterBinding` or proxy `recruiterUsername`, resolving recruiter bindings before calling Reply Authority Service when needed
- browser-use agent now expects v2 signed envelopes and validates recruiter binding before sending replies
