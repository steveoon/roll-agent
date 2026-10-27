---
"@roll-agent/runtime": patch
---

Reject synchronous reentry during model and Provider-option updates before accepting a new turn or compaction. Keep Sampling and session configuration aligned, preserve existing state when the host rejects an update, and release the update guard so later work can proceed.
