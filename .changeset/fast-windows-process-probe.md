---
"@roll-agent/core": patch
---

Short-circuit process identity probes when the target PID has already exited, and reuse the current process start token across session ownership and Agent usage leases to avoid redundant PowerShell startups on Windows.
