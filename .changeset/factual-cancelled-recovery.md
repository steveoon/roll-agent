---
"@roll-agent/runtime": patch
---

Preserve whether an interrupted tool call never started or has an unknown outcome, and make
cancelled-turn recovery defer to the latest user intent.
