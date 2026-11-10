---
"@roll-agent/runtime": minor
---

Add optional backed-up migration on writable startup for Runtime embedders with an ownership host. Set `ThreadStoreOptions.migrateOnOpen` and read the resulting `migrationBackupPath`; the default explicit migration behavior is unchanged. Automatic migration holds the library gate and a primary SQLite write transaction from before backup through schema commit, rolls back failures, and avoids global retention sweeps. Read-only operations never migrate, and unsupported future schemas remain rejected.

Remove incomplete/unverified backups and the current attempt's backup after a successful rollback, preventing failed automatic retries from accumulating full database copies. Preserve existing backups and retain the recovery copy when rollback cannot be verified; cleanup failures report both errors and the retained path.
