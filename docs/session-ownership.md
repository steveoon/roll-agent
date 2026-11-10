# Writable session ownership

Roll CLI, `runtime serve`, legacy `chat --server`, and scheduled execution use
`createOwnedThreadStore()` from `@roll-agent/core/runtime-host/session-ownership`.
The Runtime remains independently embeddable: `new ThreadStore(dir)` preserves the
uncoordinated embedding API; embedders opt in with `ThreadStoreOptions.ownership`
(`SessionOwnershipHost` from `@roll-agent/runtime/host-contracts`). Do not advertise
protected ownership for an unconfigured embedded Runtime.

`ROLL_SESSION_OCCUPANCY_CAPABILITY` attests Core's host integration;
`SESSION_OCCUPANCY_CAPABILITY` attests the Runtime implementation. They are public
artifact metadata, not new Protocol fields. Verify both from the actual trusted
artifact. Existing Protocol 1.6 returns `THREAD_BUSY`, `retryable: true`, and JSON
`details.reason = "session_occupied"`, with safe `ownerKind`, `label`, `workspace`,
`threadId`, and `action = "close_other_client_and_retry"`. No process identity or
credential is exposed. Reopen after the other client exits; this acquires ownership
and reloads persisted state, rather than reusing a detached session.

## Storage and lifecycle

Claims live in `<canonical SQLite file>.occupancy.sqlite`. The primary database
uses schema 12, including nullable workspace attribution. Symlink aliases resolve to the same SQLite file and sidecar;
writable hardlink aliases and dangling file symlinks are rejected because their
journal identity is ambiguous. Same thread IDs in different libraries are
independent. This supports cooperative processes on one machine and local
filesystems, not distributed or network filesystems, uncooperative file replacement,
old binaries, or concurrent tools that bypass the ownership contract.

Acquisition, dead-owner reclamation, and release use SQLite transactions/token CAS.
Core captures the OS process creation identity, including boot identity where the
platform helper provides it. Identity unavailable, permission errors, and malformed
identity are occupied, never dead. No heartbeat, idle timeout, forced takeover,
process-name matching, or process termination is used. A library maintenance claim
atomically excludes all thread claims.

A session retains its claim while waiting for input. Each persistence callback
captures its exact token; all public ThreadStore mutators also fence synchronous
writes. Temporary metadata claims do not release a retained session claim. Multiple
opens coalesce inside an Engine, and independent Engines cannot reserve the same
protected store/thread. Service attachments retain ownership even before opening a
session. Metadata, deletion, backfill, tool ledger, input receipts, compaction, and
Runtime event writes participate. Empty CLI cleanup rechecks emptiness under its
write claim.

Closing rejects new work immediately and waits for turn/compaction producers,
known shell-session cleanup, protocol terminal projection, and staged attachment
cleanup before release. A failed barrier retains the claim; repeated close waits
on the same result. Reading/deleting a shell cleanup-failure tombstone does not
convert it into proof of process-tree settlement. OS death permits reclaiming the
parent's claim; it does **not** prove arbitrary external MCP work or orphaned child
side effects stopped, and does not promise exactly-once effects.

Deletion retains its temporary claim through session, event and attachment cleanup.
If cleanup fails, ownership remains fenced. Once cleanup settles, a failed database
DELETE releases the temporary claim and closing state so the request can be retried
and another client can reopen the surviving history.
The original `requestId` still replays its cached failure; an explicit new deletion
attempt must use a fresh `requestId`, following the existing mutation contract.

## Read-only inspection and automatic migration

`inspectThreadLibrary(dir)` never creates a directory, claim, or database and never
migrates. It returns `databasePath`, optional `physicalIdentity` (`inode:dev:ino:birthtimeNs`) and
`writableAliasSafe`, `schemaVersion`, `supportedSchemaVersion`, and `status`:
`new`, `current`, `needs_migration`, or `unsupported`.

Core's protected normal constructor opts into `ThreadStoreOptions.migrateOnOpen`.
Known older schemas are backed up, verified and upgraded automatically on writable
open, including normal chat, Runtime service and scheduled execution. A successful
upgrade reports the backup path on stderr; stdout remains usable for JSON/stdio.
New/current libraries create no backup. Read-only inspection never migrates.
Automatic startup rejects unversioned existing evidence and unsupported future schemas.

Automatic initialization uses the existing library gate to exclude all live or
unverifiable thread claims. An idle scheduler does not hold a conversation claim
and does not need to stop, uninstall or restart. A conflicting session must finish
before retrying; Roll never terminates another client or takes over its live claim.
The primary SQLite `BEGIN IMMEDIATE` transaction starts before backup, rechecks
the schema, and remains held until the migration commits. Backup or migration
failure rolls back the transaction and releases initialization resources for retry.
An incomplete or unverified backup is removed. Once rollback succeeds, automatic
migration also removes that attempt's verified backup; older backups are untouched.
If rollback cannot be verified, the verified backup is retained and its path is
reported. Cleanup errors preserve the initiating error and report the retained path.
Automatic migration does not run global retention sweeps.

Runtime embedders retain the default explicit migration behavior unless they opt
into `migrateOnOpen` alongside `ownership`. Writable automatic migration without
an ownership host is rejected. `ThreadStore.migrationBackupPath` is the verified backup
created by that open, or `null`. The explicit APIs
`migrateOwnedThreadLibrary(runtime, dir, true)` and
`migrateThreadLibrary({ dir, ownership, confirmStoppedLegacyClients: true })`
remain available for clients that manage migration themselves.

For manual maintenance, users can run `roll runtime migrate` in the original project directory to inspect
the selected library and receive the confirmation instructions. It does not require
LLM configuration or create a library when none exists. After stopping every CLI,
desktop client and scheduler using that library, explicitly confirm the backup and
upgrade:

```sh
roll runtime migrate --confirm-stopped-clients
# Select a library explicitly, including when the original project is unavailable:
roll runtime migrate --threads-dir "/path/to/threads" --confirm-stopped-clients --json
```

`--threads-dir` overrides config discovery. Without it, the command uses the current
project's `runtime.threads-dir`. No confirmation means no migration; live coordinated
claims still block an explicitly confirmed migration. JSON success returns
`{ backupPath, preflight }`; `backupPath` is `null` when the library is already current
or absent. Unsupported future schemas are refused. This explicit command's
confirmation requirement does not apply to automatic normal startup. The existing
explicit API can also initialize an unversioned database after the caller has
inspected it and explicitly requested a backed-up migration; this is not automatic
recognition of that database as Roll history.

Migration acquires the library gate, requires no thread claims, rechecks schema,
uses SQLite `VACUUM INTO` to create a consistent unique backup, verifies the backup
with `quick_check` and the original schema version, and only then runs transactional
migration. It returns `backupPath` and the resulting preflight. Failure before
verification leaves history unmigrated. Pre-ownership clients do not honor the
session gate: an explicit command's confirmation means those clients have been
stopped, not that they were automatically detected. Automatic migration serializes
SQLite writes during backup/upgrade but does not make uncooperative legacy
applications safe to use concurrently afterward. Schema-11 CLI/Desktop Runtime versions reject a migrated
schema-12 library, even for read-only access. Upgrade all clients sharing the library
before migration; updating an external CLI does not update Desktop's bundled Runtime.

## Retention and attachment boundaries

Protected current-schema startup does not repair/prune every thread. The owner
prunes only its claimed thread on session admission, before recovery; existing
message/tool/event append retention remains scoped to the writing thread. Cold
unopened threads are physically pruned lazily, unlike the legacy eager startup
sweep. Read-only/coordinated event replay uses a read transaction and rejects an
expired range with the existing cursor-expired/snapshot recovery path; it never
silently skips events or prunes a live sibling. App-output reads still hide expired
payloads. Explicit migration can perform its legacy global maintenance because it
holds the exclusive library gate.

Attachment instances retain their own TTL behavior and delete their own files on
settled close. Startup no longer deletes another instance's directory based on age;
old directories can belong to live idle clients. Hard-death orphan directories may
remain until a separately authorized cleanup. There is no generic orphan collector.


## Binding a trusted child to a selected library

The Core public `createSessionLibraryBinding(runtime, dir)` builds an opaque JSON
launch token without creating files, including for a pristine nonexistent parent.
Pass it unchanged in `ROLL_EXPECTED_SESSION_LIBRARY`. Every Core owned-store
factory validates this constraint against the **child's actually loaded** threadsDir
before mkdir, sidecar creation, writable open, or initialization. A changed config,
replaced physical file, malformed token, or token exceeding 8192 UTF-8 bytes fails
with `SessionLibraryBindingError` (`code = "SESSION_LIBRARY_MISMATCH"`).

Version-1 tokens contain `version: 1`, canonical absolute `databasePath`, and either
`state: "missing"` or `state: "present"` with `physicalIdentity` formatted
`inode:dev:ino:birthtimeNs`. Missing and present are not interchangeable; a successfully initialized host records
the identity of the library it just created. Future launches must obtain a fresh token. Consumers should use the builder rather than
reimplement identity logic. With the variable omitted, CLI behavior is unchanged.
This closes configuration changes between preflight and child startup; it is not
an atomic defense against malicious concurrent filesystem replacement.


Actual CLI/Runtime startup explicitly calls `captureSessionLibraryBinding()`: it
validates/captures the launch constraint in a process-local context and removes
only this launch variable before spawning tools/children. All later owned stores
in that host stay constrained. Nested Roll commands can select another library
without inheriting the parent's launch constraint. Public embedders should call
capture explicitly at host startup; importing the module and building read-only
tokens have no environment-consumption side effects.
