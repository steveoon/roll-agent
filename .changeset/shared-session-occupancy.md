---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

Coordinate writable sessions across Roll CLI and Runtime hosts using process-identity-verified SQLite sidecar claims. Keep ownership during idle input, fence metadata, transcript, tool ledger, compaction, event and attachment writes, and settle execution plus terminal projection before releasing a session. Conflicts use existing THREAD_BUSY details with guidance to choose one client.

Expose read-only schema preflight and explicitly confirmed, exclusively gated history migration with a verified SQLite backup. Preserve primary history schema 11; old clients remain unverified and must be used sequentially. Reject writable hardlink aliases with ambiguous SQLite journal identity. Stop deleting other attachment instances solely because their directories are old.

Coordinated hosts prune retained tool evidence and Runtime events only for the thread they own when opening or writing it. Cold unopened threads are physically pruned lazily; unrelated startup and read-only replay never prune another owner’s history. Expired event replay requires a snapshot instead of silently skipping events.
