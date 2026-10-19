---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

Restore chat display history from the persistent transcript after compaction. Load older records when scrolling up, preserve the reading position and tool outcomes across pages, and keep displayed history separate from model context.
