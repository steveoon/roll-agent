# Configuration sources and task working directories

`roll runtime serve --stdio` continues to discover configuration from its working directory when no new options are supplied. Embedders can explicitly separate execution cwd from the configuration source:

```sh
cd "/path/to/task directory"
roll runtime serve --stdio \
  --config "/path/to/settings/roll.config.yaml" \
  --config-workspace "/path/to/original workspace"
```

`--config` must name an existing regular file. Empty or missing explicit sources fail without discovering another file. A relative `--config` resolves from execution cwd. `--config-workspace` requires both it and `--config` to be absolute; it must name an existing directory. With `--config` alone, the resource workspace is execution cwd.

The resource workspace resolves configured relative history, Agent-data, extra skill directories, explicit instruction-file, browser executable, browser profile and browser session paths. Absolute paths and `~/` retain their targets. Browser args and Agent transport commands are not rewritten. `scheduler.data-dir` retains its existing config-file-relative behavior. `auto` workspace instructions and automatic project skill discovery remain based on execution cwd. Core never calls process-global `chdir` for this feature.

The public `@roll-agent/core/config/runtime-context` export supplies `loadRuntimeConfig`, `resolveRuntimeConfigContext`, and the schema-derived version-1 context. Hosts must use the same authorized source/workspace for inspection, library admission, maintenance, startup and invalidation. Electron's Main process owns those paths; a renderer should send application IDs, not construct an execution context. The context contains path references only; no configuration or credentials should be copied into task folders.

## Scheduled tasks

A bound Runtime's built-in schedule create/list/extend tools use its selected configuration. Each new schedule stores an optional opaque host context in the Runtime ledger. Core interprets that value; Runtime only validates its size and persists it. The model/tool request cannot supply a different source. The configuration and environment are loaded at use time; secrets are never serialized into the host context.

For bound schedules, creation and extension compare a process-private configuration revision after user confirmation. A changed source or authority refuses the captured operation. An existing schedule is reauthorized from its own stored source, even when managed from another conversation sharing the ledger. The context participates in idempotent creation, so two explicitly different sources cannot accidentally merge their tasks.

The daemon dispatches the authoritative stored schedule. After invocation and process-tree preflight, Core loads that schedule's source, maps resource paths and verifies the existing authority digest before provider/tool execution. Missing files, invalid context versions, malformed contexts or unreadable sources fail the invocation without cwd fallback. Existing jobs without a context continue to discover configuration from their own cwd. Finite-round completion and existing retry/tree-settlement rules remain unchanged.

The existing service readiness contract still applies: creating a task does not install or restart an OS service. A custom scheduler data directory needs a compatible daemon serving that ledger. Warnings about an absent/mismatched daemon or service remain visible.

## Compatibility and rollout

Scheduler schema 10 adds a nullable host-context column. Supported older ledgers migrate transactionally and retain legacy rows, runs and finite quotas. Read-only inspection of supported old ledgers does not migrate them. Persisted writer guards fence already-open older connections; restart older scheduler daemons/executors using the existing service-management workflow before using the new scheduler writer.

The conversation/history database stays at schema 11. No Runtime Protocol or client-node method changes are required. Core/Runtime minor releases and a newly built standalone/bundled artifact are required; the already-published Core 1.3.0 artifact does not acquire these capabilities retroactively. Hosts should probe the actual artifact's public helper and verify its CLI flags rather than infer support from source files or an external CLI installation.
