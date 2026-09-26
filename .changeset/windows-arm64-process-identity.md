---
"@roll-agent/core": patch
---

Read Windows process creation times without loading PowerShell management cmdlets, avoiding ARM64 timeouts that blocked Agent lifecycle locks and installation or upgrade checks. Reserve time for a trusted fallback when the first PowerShell candidate stalls, while preserving the overall deadline, process identity tokens, trusted executable paths, and fail-closed verification.
