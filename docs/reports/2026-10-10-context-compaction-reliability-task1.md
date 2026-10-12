# Context Compaction Reliability — Task 1 Delivery Checkpoint

## Status and scope

- Baseline/HEAD remains `31816c3` on `dev`; no new commit, staging, push or release.
- Task 1 implemented: accept/preserve input before maintenance, reference-only Skill receipt metadata, cancellation/error offsets and Engine/SQLite integration. **Independently accepted by Codex for Task 1 only.**
- Task 2–4 are not implemented: full-request budget/residual calibration, sustained maintenance controller, fair evidence batching and durable diagnostics remain unchanged. No claim that context-window reliability is fully fixed or that the original first-task root cause is established.
- Task 1a was delivered and independently accepted in its separate batch. This report remains scoped to Task 1; no new Protocol event or input queue.
- No thinking/effort/authorization code changed; `packages/core` and `packages/protocol` have no worktree diff. Default threshold 75%, whole-turn pressure-continuation cap and post-response behavior remain unchanged in this batch.
- Current Roll host/session was not restarted/replaced; new behavior is tested in isolated sessions/temporary databases, not hot-installed into this conversation.

## Design-review amendments landed

`docs/plans/2026-10-10-context-compaction-reliability.md` now records:

1. 75% is a soft maintenance target, distinct from full-request capacity. Reserves and 120s call budget are reviewable heuristics, not server-acceptance guarantees; explicit larger output caps require corresponding reserve.
2. Maintenance before/after budgets freeze a common calibration basis; raw and calibrated estimates stay separate. Residual reset without payload reduction must not count as space progress or alone justify restored admission (Task 2 regression required).
3. Optional diagnostics/retention failure reports degraded observability and does not block otherwise reliable processing or roll back checkpoint installation. Necessary input/Tool/checkpoint storage failures stop processing. Existing checkpoint ID/generation is the transactional installed marker; optional diagnostic linkage is outside that necessary transaction.
4. Task 1 acceptance includes SQLite reopen/old schema, resume/fork, no-store/legacy callbacks, early error/cancel/timeout and explicit duplicate-text sends. No public cross-process exactly-once execution guarantee.
5. Independent tool-input-start/delta/end UI patch is deferred to Task 1a; full calls alone authorize approval/execution, per-call-ID ephemeral state, no argument bodies in UI/logs, throttling and cleanup tests planned.

## Implementation details

### Acceptance boundary and rollback

- Each ActiveTurn receives a stable internal UUID `inputId`.
- `runTurn` persists normalized raw user input before Tool reconciliation, workspace/Skill processing, pre-compaction or inference.
- Stored Engine uses `onAcceptInput`; legacy `onPersist` receives a **separate early raw-user append**, followed by response/recovery appends. A new user message never claims coverage of pending Tool evidence.
- Without a Store/persistence callback, raw input is retained only in process-local session/transcript memory. No crash durability is implied.
- `userMessagePersisted` is set after successful acceptance; response segment boundaries now start after that input. Continuations do not append it again. Generic rollback, cancellation, overflow and failed-result paths preserve the accepted prompt.
- Reconciliation can itself append durable recovery messages, so the rollback boundary is refreshed after successful reconciliation. Failure does not rewind previously durable evidence.
- Overall turn timeout includes setup/maintenance time. Synchronous Skill loading that exhausts the deadline is checked before inference; cancellation/timeout does not trigger metadata or inference after interruption.
- Cancellation persistence failure distinguishes “input saved” from “progress/interruption record not saved.” A failure to accept input is reported honestly and performs no inference.

### SQLite v8 and identity

- Additive `thread_turn_inputs` table: `(thread_id,input_id)` primary key, unique transcript sequence per thread, FK to append-only transcript with cascade. Prompt text is not copied into the receipt.
- `acceptTurnInput` uses `BEGIN IMMEDIATE` around ordinary active/transcript append and receipt insertion. Receipt insertion fault rolls back both message views.
- Same `inputId` and same raw input returns the original receipt even after reopen/active-history replacement, without reinserting a compacted prompt. Conflicting input content rejects the identity reuse.
- Explicit sends with identical text use different IDs and produce two inputs. This is not automatic dedup by text or a network retry contract.
- v7 upgrade creates the table without fabricating receipts for historic inputs. Existing v1/v2/v4/v5 Store migrations remain covered.
- Fork copies historical metadata but remaps receipt IDs; it does not copy live turn/retry authorization or start inference. Thread deletion cascades receipts; other threads stay isolated.
- Compatibility note: schema v8 is additive, but older binaries with a v7 maximum still fail closed on newer databases as before. No live user database was reopened/migrated to deploy this feature in this session.

### Skill references and history

- Current Skill bodies remain ActiveTurn-local and are reused for internal context-overflow retry, not read twice or archived in raw input.
- `recordTurnSkillCheckpoint` stores only checkpoint version/kind, selected names and content-hash/source references; excludes `userPrompt` and `modelUserContent`.
- Same metadata is idempotent; conflicting snapshots reject overwrite. New raw transcript rows are never rewritten to add metadata.
- For compaction evidence only, sidecar references are projected transiently into a legacy-compatible checkpoint shape; the parsed prompt is reconstructed from raw slash input. Ordinary inference still uses the actual current-turn loaded snapshot, not historic body materialization.
- Engine callbacks restore receipt metadata for compaction; no-store or onPersist-only callers without a metadata callback have process-local references, not durable reference claims.
- Existing legacy checkpoint parser/migration remains compatible. Tests assert subsequent ordinary turns/resume/fork do not load old Skill bodies.

## Regression changes that require reviewer attention

Early acceptance necessarily changes callback counts and when the latest user-turn boundary exists:

- Update one-batch user+response expectations to two incremental appends, keeping the complete concatenated transcript assertions.
- Fault injection targeting response/recovery storage now exempts the already accepted user row; otherwise it would prevent the very Tool effect that the test intends to inspect. New separate tests cover acceptance transaction failure.
- Failed/no-output/closed turns now retain the accepted user message; no terminal state is fabricated when Tool ledger writes fail.
- Pre-compaction now sees the new accepted turn boundary. An earlier Tool pair may legitimately leave the active model projection and move to a checkpoint sooner. Tests still assert exact original durable Tool counts, no replay and call/result pairing; projected history permits zero or one pair, with a real checkpoint required when removed.
- Test fixture issues found/fixed: double-close of a SQLite Store, wrong Engine fork API argument, missing `ask` config, premature legacy persistence signals and type-only import after lint auto-merge. An initial full targeted run was interrupted after a fixture waited on a now-unreachable boundary; final full Runtime run completes normally.

## Verification evidence

Environment: macOS, Node 24.21.0, pnpm 11.24.0. All commands below executed in the worktree, returned exit 0 on the final run unless explicitly stated as an intermediate failure above.

| Command/check | Final result |
| --- | --- |
| `pnpm --filter @roll-agent/runtime typecheck` | Passed |
| `pnpm --filter @roll-agent/core typecheck` | Passed, includes UI |
| `pnpm --filter @roll-agent/protocol typecheck` | Passed |
| New Task 1 suites (`turn-input.test.ts`, `turn-input-persistence.test.ts`, `turn-input-engine.test.ts`, `turn-input-failures.test.ts`) | **17 tests, 17 pass, 0 fail** |
| `pnpm --filter @roll-agent/runtime test` | **1553 tests, 1536 pass, 0 fail, 17 skip** (platform PowerShell skips) |
| `pnpm --filter @roll-agent/core test` | **1930 tests, 1925 pass, 0 fail, 5 skip** |
| `pnpm --filter @roll-agent/protocol test` | **48 pass, 0 fail** |
| `pnpm lint` | Passed |
| Fast verification on all changed code files | Passed after fixes |
| `pnpm --filter @roll-agent/runtime build` | Passed, 119 JS files minified |
| `pnpm --filter @roll-agent/core build` | Passed, 292 JS files and React UI built |
| `node packages/core/dist/cli/index.js agent health` | Passed; only status/readiness, no subscription inference |
| `pnpm exec changeset status` | Valid; new Runtime minor changeset plus existing committed Core thinking minor |
| Targeted Prettier + `git diff --check` | Passed |

### Required invariants demonstrated

- Receipt A accepted twice: one archived input. A after reopen/active replacement: no active reinsertion. B with identical raw text: second archived input.
- Receipt insert failure: zero active/archived insertions and no receipt.
- Maintenance fault, cancel, timeout, Skill read failure, Skill metadata write failure, setup rollback: first prompt exactly once; zero inference calls for that terminal failure; a later prompt still works.
- Actual local compaction-model provider error through the installed SDK: summary attempted, inference not started, accepted input retained.
- Synchronous Skill cancel/expiry: no inference or metadata write after termination; raw input retained; subsequent turn works.
- Real SQLite close/reopen + Engine resume/fork: no inference merely from resume/fork; new fork receipt IDs, same body-free historical references; no old Skill reload.
- Existing Tool suites retain once-only effects, cancellation not_executed/outcome_unknown distinctions, exact ledger coverage, repeated toolCallId occurrences, Store CAS and interrupted recovery behavior.

These use real local SQLite and the installed SDK with MockLanguageModel/controlled local transports. They are **not real subscription calls**, do not establish production compaction latency or server acceptance, and do not test the future complete-budget controller.

## GitNexus coverage and risks

- Before editing: baseline graph impact for `runTurn`, `persistCancelledTurn`, `persistFailedTurn`, `buildSession`, Skill checkpoint readers/writers, Store init/snapshot/fork and transcript evidence. `runTurn` and interruption persistence are CRITICAL; `buildSession` HIGH. Ambiguous/UNKNOWN method lookups were supplemented with exact source/callback inspection rather than interpreted as unused.
- Refreshed via `node .gitnexus/run.cjs analyze --index-only`: success, 40,072 nodes, 113,162 edges, 1106 clusters, 1043 flows. It indexed new modules/test files without staging them.
- Structured `detect_changes(scope=all)` for **tracked** changes: 8 files, 50 symbols, 21 affected flows; risk CRITICAL; `partial=false`, `truncated=false`. Some files are structural/test assertion edits and have no changed-symbol listing. This is not a whole-worktree all-clear: untracked additions are excluded from git diff.
- New source modules/methods separately queried: `acceptTurnInput`, `recordTurnSkillCheckpoint`, `projectTurnInputSkillCheckpoint`, `getTurnInputSkillCheckpoint` resolved with one callback/project caller and graph LOW. That low score does not waive persistence operational risk.
- Analyzer warnings remain: callable-value-flow candidate cap, cross-language fields not linked, ranked entry-point/branch/walk budget omissions. Complete detect result flags do not erase global graph limits. Minor type-import/test/document edits after the analyzer started may not be reflected in its source freshness hash; production call topology reviewed is unchanged by those edits.
- No commit made, so no claim of a clean final pre-commit graph gate for future commits. Future batch changes require new impact/index checks.

## Risks / remaining work

1. Early persistence and segment offsets affect every interruption path. Independent review should inspect `runTurn`, `persistCancelledTurn`, `persistContextFailure`, `persistFailedTurn`, `appendInterruptedTurnMessages`, Tool reconciliation and Store acceptance transaction together.
2. Legacy onPersist-only integrations must append batches, not overwrite the entire turn from the latest callback. They already received incremental continuation segments; Task 1 adds the early input batch. Metadata durability requires the new callback/Store wiring.
3. Task 1 stores input safely but does not yet prevent all oversized inference requests or remove the two-episode cap. Do not conflate preserved input with successful inference.
4. Receipt lifecycle and forked historical metadata are not cross-process exactly-once execution authority.
5. No post-response maintenance, live-host replacement, public Protocol extension or tool-parameter status UI patch is included.
6. Full Core E2E was not re-run for this Task 1 checkpoint; full Runtime/Core/Protocol tests, actual Store reopens and published-load smoke did run. Phase 1 final delivery still requires the planned E2E/full verification matrix.

## Independent Codex acceptance (coordinator-reported, 2026-10-10)

Codex reports Task 1 passed after independently reading the final diff and rollback/cancellation/Tool recovery/SQLite call chains. Independently re-run: new 17 tests, related 275 tests, Runtime 1536 pass/17 skip, Core 1925 pass/5 skip, Protocol 48 pass; three-package typechecks, lint, Runtime/Core builds and published CLI checks passed. Full Core E2E and actual subscription inference with new code were not performed. These are explicitly attributed independent-review results, distinct from Roll's tool results above.

Acceptance is limited to input reception/persistence, **not the entire Phase 1 context-window change**. Task 1a is now authorized as a separate batch; Task 2–4 remain gated. No commit/push/release/live-host restart is authorized.
