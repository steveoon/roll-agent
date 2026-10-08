---
"@roll-agent/runtime": patch
"@roll-agent/core": patch
---

Fix context compaction stalling when an earlier long turn exceeds the semantic evidence batch. Compact completed steps within the evidence boundary while preserving later turns, tool pairs, and durable checkpoints. Apply the context budget to manual compaction and report attempts that do not reduce context without claiming compression is unnecessary.
