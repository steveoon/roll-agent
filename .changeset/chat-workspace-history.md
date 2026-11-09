---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
"@roll-agent/protocol": minor
"@roll-agent/client-node": minor
---

Persist optional workspace attribution in conversation history schema 12 and expose project filtering and advisory occupancy through the optional Protocol 1.6 `thread.browse` method and Node `browseThreads()` helper. Existing thread summaries and list payloads remain unchanged. Read-only inspection does not acquire ownership, migrate history or reap claims; writable sessions still require atomic ownership.

Existing libraries require the existing explicit, verified-backup migration. Upgrade every CLI and Desktop bundled Runtime sharing the library before migration: schema-11 clients cannot open schema 12. Legacy conversations remain unclassified.
