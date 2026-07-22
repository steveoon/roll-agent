---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
"@roll-agent/sdk": minor
---

Strengthen `roll chat` with resource-aware batch tool scheduling, typed three-layer tool results, bounded context-overflow replay, and direct explicit Skill preloading scoped to the active Turn with reference-only persistence. Durable Tool evidence now uses bounded write-time-redacted projections, automatic per-thread retention, and explicit Raw RPC authorization. Add atomic V2 compaction checkpoints with V1 compatibility, transcript recovery, provider-portable schema-constrained semantic drafts, user-only destructive transitions, structured constraint revocation, exact model-facing evidence excerpts, bounded evidence batches and watermarks, and deterministic hard-bounded checkpoint reminders. Semantic state is the validated V2 recovery fact source; compatibility goal/constraint projections must match it, and the state is injected once per Turn instead of duplicating derived summaries in active history. Legacy V1 active snapshots migrate only as low-confidence uncertainties, are atomically archived as redacted paginated transcript evidence, and remain untouched when the first V2 reminder cannot expose every migrated fragment. Also add a fail-closed capability manifest, safe debug snapshots, and a real Ink PTY performance harness with optional fail-closed baseline comparison.

Without a durable transcript store, legacy V1 checkpoints now remain active instead of being upgraded into V2 state whose source evidence could not be recovered.

Keep explicit Skill bodies scoped to the active turn, and persist only lightweight Skill references. Bound and redact durable Tool evidence, prune it by age and per-thread quota, and require explicit host authorization before JSON-RPC clients can request the retained raw/input projection.

Stream provider reasoning into a separate, non-persisted Ink thinking block and show responsive per-phase turn status above the prompt without conflating model wait, reasoning, reply, or tool activity.

Make schema-constrained compaction configurable through `runtime.compaction.timeout-ms`, `runtime.compaction.max-output-tokens`, and an optional `runtime.compaction.thinking-level` override. Compaction now defaults to a 120-second provider budget and 8192 output tokens, inherits the runtime thinking level through AI SDK's unified reasoning semantics where supported, keeps Qwen's required structured-output thinking override, reports phase timings in verbose mode, and recognizes xAI's non-streaming output-limit response without weakening fail-closed history and checkpoint semantics.
