---
"@roll-agent/core": patch
---

Restore automatic history upgrades during normal writable startup. Roll Chat, Runtime service and scheduled execution back up and verify known older libraries before migrating, without requiring a separate command or scheduler service uninstall. Idle schedulers keep running; live or unverifiable session claims still block migration.

Successful upgrades report the verified backup path on stderr without changing JSON/stdio output. Read-only operations never migrate. Older clients that do not support the new schema must be upgraded before reopening the shared library.
