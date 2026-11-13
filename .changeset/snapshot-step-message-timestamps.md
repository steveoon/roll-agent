---
"@roll-agent/runtime": patch
---

Preserve causal step ordering between assistant messages and tool executions in `thread.snapshot`. Record monotonic per-step timestamps when persisting multi-step turn messages while keeping transcript and tool coverage writes atomic, and align legacy batched transcript timestamps against read-only turn boundaries and paired tool execution metadata consistently across full and paginated snapshots without migrating SQLite schema 12 or changing Protocol 1.6 payloads.
