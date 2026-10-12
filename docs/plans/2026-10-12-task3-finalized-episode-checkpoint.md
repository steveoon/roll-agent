# Task 3 — Finalized Episode Contract Checkpoint

## Status

Later update, 2026-10-12: this is the historical design checkpoint. Its staged SDK-boundary contract was approved; after the half-window incident the user transferred implementation to Codex. Implementation and verification are recorded in `../reports/2026-10-12-context-compaction-task3.md`. Task 4 remains excluded. The original status below refers to the time of this design submission.

Task 2 independently ACCEPTED (read its independent-review report, including snapshot hashes). Task 3 alone is human-authorized in this Roll session. **No Task 3 production code or tests modified yet.** This is a concrete design-contract checkpoint for independent Codex review, as requested when a material design clarification is required; it is not a request for renewed end-user authorization. Task 4 and Phase 2 remain excluded.

Baseline/worktree: `dev@31816c3`, `/Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent`. Accepted Task 1/1a/2 changes remain dirty, unstaged/uncommitted. No host restart, model/thinking/approval changes, automation resumption, commits/push/publication.

## 1. Contract conflict to resolve before edits

The original section 4.2 specifies mandatory finalized `before`/`after` on `CompactionPassResult` returned immediately from `runCompaction`. Section 4.3 requests readiness checking during a continuing maintenance episode. The independently approved SDK revision section 6 instead establishes:

- finalized production SDK preparation is authoritative;
- no duplicated conversion, schema/description resolution or asset download for budgeting;
- after remains absent if cancelled before actual re-preparation;
- refused preparations incur costs and must be bounded separately from Provider calls;
- frozen comparison basis spans the same owning episode.

Current production `runCompaction` commits checkpoint/history without creating a new inference SDK request. `RequestBudgetTracker.prepare` can finalize the comparison only when the next actual wrapper receives the prepared params. Consequently an immediate mandatory finalized `after` is not available without either an unauthorized shadow preparation or falsely treating the logical predictor as finalized.

**Recommendation: staged pass verification, not shadow streams and not guessed after.** All existing Task 2 final-admission rules remain intact. This updates the result/lifecycle contract of Task 3, not the evidence cap, reserve policy, compression authority or user authorization.

## 2. Proposed result types (schema-derived, no duplicate union)

Define runtime stage/kind constants or Zod discriminated schemas in `compaction-recovery.ts`:

1. `pass_installed` (or `pass_no_commit`): records validated coverage before/after, active projection digest, actual returned checkpoint generation, draft Provider request count/usage/elapsed time and optional finalized before. **No finalized after field.** May describe `coverage_progress`, otherwise `no_progress`; byte delta is separate observation, never `space_progress` authority.
2. `pass_verified`: produced only after the next actual guarded SDK preparation, referencing the same episode/pass/install generation and frozen baseline. It adds actual prepared budgetAfter and same-basis savedTokens; then classifies complete-request `space_progress`, `coverage_progress` or `no_progress`.
3. `episode_closed`: readiness/advisory miss/cancel/error/cost exhaustion reason. A cancelled pass remains before-only. No inferred actual request readiness from checkpoint generation, raw bytes or contiguous coverage alone.

A cold pre-request maintenance pass may lack finalized before because no actual preparation exists yet; it may advance coverage, not claim finalized savedTokens. Prefer reaching the guard before automatic episode work rather than creating an estimate-only finalized before. Manual compact can remain coverage/history maintenance and must not claim readiness until later actual inference preparation.

The schemas are internal process-local state in Task 3. Durable records/retention and public diagnostic APIs remain Task 4. Existing necessary Store checkpoint row remains installation truth; optional controller observations cannot roll it back.

## 3. Episode scheduling with actual SDK checks

- An episode begins at a settled pressure boundary/final guard, scoped by accepted input ID + episode ID. State includes the last actual budget (if present), frozen residual, material-space baseline, validated watermarks, deadline, remaining draft-call/preparation limits, equivalent-state fingerprints and per-state fallback flag.
- Settle and persist prior Tool steps/coverage exactly as Task 2 before starting work. Do not reset ActiveTurn deadline, cancellation, maxSteps or invalid-schedule/coordinator history.
- Perform one validated pass/install, then reconstruct the **next actual intended inference stream** using production composition. This is not a separate dry-run preparation. The guard consumes its finalized params: if below target, close episode and dispatch; if still maintenance-needed, record after but refuse dispatch, retire its empty batch and continue the same episode.
- Four consecutive pass installments are one scheduling quantum; yield the event loop after the fourth. Every bounded attempt, including denied SDK preparation, remains in the same episode, so yielding never grants a Provider call or renews call/deadline budget. No whole-send success limit: a genuinely new Tool result after a closed episode may start another episode.
- Episode-baseline residual is **not** discarded after the first verified pass. Each pass must compare both local and aggregate space change under that frozen basis. A later ordinary request after a closed episode returns to Task 2 shape-compatible measurement rules.
- Coverage-only advances can continue when total budget grows, within the shared limits. Equivalent semantic state fingerprints exclude checkpoint UUID/generation/timestamp but include actual active projection, validated contiguous watermark pair, semantic/reminder content digest, protected input and request shape. One-byte changes cannot reset the episode's cost budget or count as material recovery.
- At repeat state/cost expiry: at most one deterministic fallback for that state, no repeated identical summary request. Actual finalized admission can close with one-shot advisory target miss if fitting; unsafe/unchanged Provider-rejected requests stop recoverably. No network call just to measure progress.
- Recommended initial preparation ceiling: `maxDraftCalls + 2` for one re-preparation per pass plus initial/final allowance. If deterministic passes can exceed that, count them in a separate pass ceiling using the same bound; do not introduce unbounded truncate loops merely because no summary Provider calls occur. Codex should confirm this concrete additional ceiling.
- Episode timeout uses absolute deadline `min(episodeStarted + settings.timeoutMs/default120s, originalTurnDeadline)`; each call takes remaining time. Cancellation checks apply before provider requests, before commits, after quantum yield and before admission.

## 4. Fair evidence and coverage-only installation

- Pure lane selector in `compaction-evidence-batch.ts`: current goal if outside oldest-uncovered lanes, alternating ordered message/Tool, resources only spare slots. Keep 32 evidence and production 48k chars, including existing previous-state projection.
- Fairness must be enforced after serialization, not merely ordering: reserve/check the oldest message and oldest Tool before filling either lane. If a mandatory oldest bounded excerpt cannot fit, return `evidence_unpresentable` without skipping/forging coverage or calling the summarizer on the same impossible selection.
- `includedEvidenceIds` remains model-presentation truth; watermarks advance solely from validated quotes/reviews or existing safe deterministic coverage. A resource or captured range does not count as semantic coverage.
- `compactMessages` may generate a semantic draft when active removal/truncation is zero **only when uncovered evidence can advance coverage**. `prepareSnapshot` validates coverage-only candidates. Commit same active history with the validated new semantic state/watermarks under existing expected history/checkpoint CAS; never store SUMMARY/ACK duplication.
- Existing Tool protocol repair, protected newest input/group, provenance, V1 migration/reminder completeness remain mandatory. Fair selection does not grant permission to remove unpresented Tool message evidence.

## 5. Actual summary Provider request/retry accounting

Current `generateCompactionDraft` uses `generateText` with `maxRetries:0` at `compactor.ts:487`. Thus there is **no enabled SDK automatic draft retry in this current production function**, contrary to original section 4.3 wording about its existing internal retry. Do not enable retries as part of this change.

Wrap only the summary model's actual `doGenerate`/`doStream` entry for request-cost admission/counting via public SDK middleware. Every actual attempted Provider request consumes budget **before dispatch**, including any future retry path. SDK preparations/onStart, semantic validation failures and deterministic fallbacks are separate counters, not Provider-call counts. Underlying providers may themselves retry HTTP internally; the provider-neutral interface cannot prove hidden network attempts. Report the measured boundary honestly rather than claiming visibility beyond it.

One cancelled/denied preparation does not count as an actual Provider request. A failed actual summary request still consumes request budget. Reuse the episode remaining timeout; fail closed before a call when no budget/time remains. Structured compaction remains exempt from inference request guard; the wrapper here only meters summary cost/deadline, not recursive context admission.

## 6. Required tests after design decision

- At least three completed successful episodes within one send using installed SDK mock Provider, fixed original deadline/maxSteps/input identity; no whole-turn disable after the second.
- >32 message backlog and old Tool evidence: both lanes presented under actual char cap and both contiguous validated watermarks advance across passes; oversized oldest evidence causes explicit bounded stop.
- Coverage-only install preserves active messages and CAS; SQLite reopen recovers validated watermarks/source IDs. Captured ranges do not grant semantic coverage.
- Checkpoint growth/byte-only change/no-progress: finalized net space not fabricated, material aggregate threshold not reset by tiny shrink, repeat state summarizer calls bounded, quantum not a readiness bypass.
- Actual summary request failure/retry fixture invokes counted provider boundary; denied preparations/fallbacks have distinct counts and share original absolute episode deadline.
- Real local write before maintenance, successful continuation and SQLite reopen: one effect, same exact ledger ID, correct Tool pairing/coverage and no replay. Pending unknown effects never auto-retry.
- Multiple verified passes preserve frozen baseline residual; cancel/error before the next actual prepare leaves after absent and next user send cannot fill it.
- Focused helper/compactor/semantic/protocol/cancellation/Skill/session tests, relevant Runtime/Core/Protocol regressions/types/lint, changeset and Task 3 final delivery report. No production/remote subscription calls implied by mocks.

## 7. Investigation evidence and risk

Read independent Task 2 acceptance and original Task 3 plan. Current concrete sources:

- `agent-session.ts:3223-3338`: capture builds message-first registry then bounded model context; actual starvation point.
- `compaction-semantic-state.ts:685-730`: sequential fitting loop stops at first nonfit and prioritizes first previous item; fair ordering alone cannot prove post-char fairness.
- `compactor.ts:569-579`: no-removed path returns before summarize, blocking coverage-only draft generation.
- `agent-session.ts:3652-3656,3801-3814`: skips no-removal snapshot, gates installation/watermarks on active-history byte reduction.
- `agent-session.ts:2180-2221`: current guard-owned recovery performs one pass then actual next preparation; the natural point to continue an episode without shadow SDK conversion.
- `request-budget.ts:193-223`: pending comparison owner protects turn identity but residual is consumed after one preparation. Task 3 needs episode-owned frozen basis across multiple verified passes.

GitNexus bound explicitly via `list`: repository `roll-agent`, worktree above, HEAD/index `31816c3`; 15 registered repos, explicit repo parameter used. Refreshed successfully: 41,060 nodes / 191,991 edges / 1117 clusters / 1047 flows. File impact shows AgentSession consumers in Engine/CLI/Runtime service, compactor consumers AgentSession/checkpoint/Store; compactor file risk MEDIUM with 86 traversed entries. Named `runCompaction`/`generateCompactionDraft`/`buildCompactionSemanticModelContext` unresolved UNKNOWN, semantic file ambiguous. Source inspections above establish actual consumers; UNKNOWN is not an all-clear. Shared mutation must be treated as HIGH/CRITICAL operational risk even when file metric says MEDIUM.

Analyzer warnings retain candidate caps, cross-language linkage misses and ranked trace omissions. No complete caller/process/future commit clearance is claimed. No production edit has been made at this design checkpoint; inspect/fresh impact required before coding after approval.

Runtime/Core+UI/Protocol baseline typechecks passed. No Task 3 tests or implementations exist yet, so no Task 3 verification/delivery success claimed. Index refresh is not host restart or deployment. No background job remains when this checkpoint ends.

## Requested independent decision

Confirm the staged installed/verified pass contract, same-episode stream reconstruction for actual finalized checks, episode-long frozen comparison, preparation/pass ceilings and accurate provider-boundary draft count. This reconciles Task 3 section 4 with the independently approved no-shadow-preparation rule. After written engineering review, continue already-authorized Task 3 and stop at independent implementation acceptance; no end-user reapproval or Task 4/Phase 2 authorization requested.
