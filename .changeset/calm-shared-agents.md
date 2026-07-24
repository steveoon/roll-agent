---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

Add cross-process usage leases for core-managed HTTP Agents so `roll chat`, `roll run`, and
`roll ask` can share one runtime without one client shutting it down underneath another. Explicit
`roll agent start` creates persistent runtimes, while lease-started runtimes stop after the final
holder exits; `agent stop`, install, remove, and update now respect active usage and lifecycle locks.

Persist stable process identity and runtime retention in sidecar schema v3 while continuing to read
legacy v2 sidecars. Invalid Roll configuration no longer falls back to and mutates the default Agent
registry during update. Agent updates reject in-place name changes and can recreate a missing npm
install directory without losing rollback semantics.

Expose the optional `ConversationEngineOptions.acquireAgentUsage` integration hook so runtime hosts
can provide their own usage-lease acquisition policy.
