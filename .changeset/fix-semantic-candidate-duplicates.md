---
"@roll-agent/runtime": patch
---

Coalesce repeated grounded compaction candidates before validating checkpoint ID uniqueness. Preserve equivalent evidence, reject conflicting identities or evidence overflow, and recover invalid model candidates through the existing deterministic compaction fallback without weakening persisted-state validation.
