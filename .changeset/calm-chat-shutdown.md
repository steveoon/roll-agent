---
"@roll-agent/core": patch
"@roll-agent/runtime": patch
---

Allow chat to exit cleanly after a managed local HTTP Agent crashes while preserving errors for live or unverifiable servers. Cancel background model catalog refresh on chat exit so pending network activity does not delay returning control to the shell. Stabilize the crashed-Agent lifecycle test by waiting for chat readiness and cover shell input recovery in Windows CI.
