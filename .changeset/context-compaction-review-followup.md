---
"@roll-agent/runtime": patch
---

Allow bounded historical completion records to leave the active compaction reminder while preserving archived checkpoints, transcript evidence, and explicit omission counts. Require new facts to survive the next reminder, preserve visible active requirements, and prioritize active facts over historical completions.

Back off from unsuccessful advisory compaction within a turn until input grows materially or request configuration changes; retain unconditional hard-limit checks. Bound summary output reservation for small context windows. Keep Runtime message stream identity across internal preparation retries and settle partial streams on failure or cancellation.
