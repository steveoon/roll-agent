---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

Separate scheduled execution conversations from ordinary chat history. Add `/schedule` browsing,
`roll schedule inspect`, and `roll chat --from-run` to inspect execution records and start a separate
discussion from a committed snapshot using the current workspace configuration. Preserve run-to-thread
associations across retries, task removal, and ledger retention, and conservatively classify legacy
conversations with verified ledger links. Runtime conversation lists now exclude scheduled originals,
which remain readable by ID and reject interactive continuation.

Make snapshot continuation a prominent, labeled keyboard action that remains visible while scrolling
and in narrow terminals, with explicit progress and unavailable states.

Keep chat initialization read-only toward the scheduler and other workspaces. Scheduler-owned
entrypoints backfill durable references; chat only classifies threads in its own store. Rebuild snapshot
provenance as model-only system context, preserving genuine user history. Return raw status/mode enums
from inspection JSON, with null and explicit reason codes when historical state is unavailable.
