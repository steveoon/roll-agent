---
"@roll-agent/runtime": minor
---

Preserve accepted user inputs before context maintenance, Skill loading and inference, including cancellation, timeout and failure paths. Add idempotent thread-scoped input receipts with append-only transcript storage and body-free Skill references, and retain historical metadata across resume and fork without replaying turns or Tool side effects.
