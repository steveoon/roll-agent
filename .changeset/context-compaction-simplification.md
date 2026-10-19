---
"@roll-agent/runtime": patch
"@roll-agent/core": patch
---

Simplify context compaction to one bounded task summary plus recent original messages, with optional chunked transcript lookup for older details. Keep finalized request budgets, accepted-input persistence, settled-tool accounting and atomic checkpoint commits. Failed or non-shrinking summaries retain history; remove semantic coverage scheduling, archive fallback and the context recovery gate.

Write V3 summary checkpoints while preserving old databases and protocol events. Reopen V1/V2 sessions with their existing bounded reminders and use the normal summary path for their first V3 compaction. Read old checkpoints, ledgers and recovery notes through paginated transcript lookup; archive only removed legacy summary fragments missing from the transcript. Retention gaps affect the requested historical read without blocking the chat. Keep explicit truncate configuration compatible and preserve existing tool approval behavior.

Include retained user instructions as budgeted summary context, so compaction within a long turn can see the current request and authorization. Give recent original user messages precedence over conflicting historical summaries.
