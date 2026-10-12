# Task 2 — Corrective Delivery for Independent Acceptance

## Status and scope

**Task 2 independently ACCEPTED by Codex, limited to the Task 2 scope.** See `2026-10-12-context-compaction-task2-independent-review.md` for the independently executed results and source snapshot hashes. This supersedes the historical failing WIP checkpoint, not Codex's acceptance authority. Phase 1 is not complete. Task 3 (fair evidence/controller), Task 4 (durable diagnostics) and Phase 2 (efficiency/memory targets) have not started.

Baseline/HEAD `dev@31816c3`; all Task 1/1a/2 work remains unstaged/uncommitted. No push, publication, host restart/replacement or edits to user model/thinking/approval settings. Model switches in tests operate on isolated fixtures only. No input queue or execution-time user prompt insertion.

## Independent review findings addressed

Read `docs/reports/2026-10-12-context-compaction-task2-independent-review.md` and both `/tmp/codex-task2-independent-probes.mjs` and its historic log before changing code. Independently supplied findings were not assumed fixed by preexisting unit tests.

### 1. Ordinary incompatible residual versus frozen episode calibration

`RequestBudgetTracker.prepare` first calculates actual prepared request shape with zero residual, then compares it with the matching most recent measured request. Ordinary admission uses residual **only when compatible**. Capability/schema, system/workspace, Provider options and model changes invalidate ordinary correspondence.

A pending maintenance comparison is different: its prior residual is deliberately frozen for its owning turn and actual next guarded preparation, so changing the checkpoint cannot create fake space improvement by clearing the residual. Both raw and calibrated numbers remain visible. Measurements count input (including cached occupancy), not cumulative input billing or all reasoning/output as future history.

Production-path review probe now reports:

```text
schema-refresh-incompatible-residual:
  underlying Provider calls=2, measurementMatched=false
  raw=2477, residual=0, calibrated=2477, ceiling=9300
  secondTurnErrored=false
```

New tests cover the existing user-input capability refresh plus ordinary agent/schema, workspace/system and Provider-option refresh paths. A Tool-triggered mid-turn capability/schema change now retires the old settled SDK stream and re-prepares the actual effective ToolSet before dispatch. That fixture performs one read, two underlying Provider calls and three prepared attempts; the stale-schema attempt is not dispatched and the read is not replayed.

### 2. Unknown-window overflow requires complete-request net reduction

Keep the Provider-rejected budget **and** fingerprint. Both stream-error and result-Promise overflow recovery branches preserve that basis. The actual next finalized guard refuses automatic redispatch unless raw **and** frozen-calibration estimates are genuinely smaller than the rejected complete request; changed checkpoint ID/fingerprint/history bytes alone do not authorize it. Exact rejected fingerprints remain blocked.

Review reproduction now makes **one** underlying Provider call (1073 estimated tokens); the 1704-token checkpoint-expanded request is guarded, not dispatched. The turn ends recoverably and input stays saved. A separate oversized-history fixture with substantial removable payload demonstrates real safe retry; an unknown-window request cannot gain permission merely from a new marker.

Small historic overflow fixtures previously expected retry after removing a few short words while adding a longer checkpoint. These now seed an explicitly large older answer so the full request actually shrinks. Preserve their once-only user/Skill snapshots, retry maximum, transcript/ledger and CLI/Runtime assertions. A separate review regression still requires refusal for the original checkpoint-growth counterexample.

### 3. Interrupted maintenance cannot be finalized by a new turn

Pending comparison carries `{ budget, owner }`, where owner is ActiveTurn's stable accepted-input identity. Only that owner's preparation may set after/savings. Every runTurn finally abandons its pending measurement on failure/cancel/timeout/termination, retaining the honest before-only comparison. New sends cannot fill it.

The review probe now reports `oldEpisodeFinalizedByNewTurn=false`. A repository regression inspects the **first preparation transition** of the next send through an observed tracker, before new maintenance can overwrite the latest comparison; checking only the eventual last snapshot is insufficient. A second pure tracker test asserts missing after/saving remains missing across owner transition.

## Request projection / predictor / dispatch authority

- `engine/model-request.ts` is the shared production Roll assembly: accepted input/history + canonical completed steps, cancellation-recovery materialization, stripping historic metadata, current-turn Skill once, capability/checkpoint reminders, actual observation projection and Tool-image relocation. Its returned messages/system/tools/options are used in `streamText`/`prepareStep`; step-current shape context is refreshed, not stuck at the first request.
- SDK remains the only exact prompt/tool/schema/description preparation. No `ai/internal` production imports, copied SDK converters, pnpm deep-import paths or second asset download. A captured-actual-SDK test checks system, Skill, both reminders, resolved description/input schema and unchanged Provider options against the estimator. Callable description resolutions remain the SDK's two fixture calls; accounting adds none.
- `estimatePreparedRequest` counts the finalized provider-neutral prompt's system/message components, prepared Tool definitions and relevant options. Snapshot contains numeric counts, digests, provider/model identity and estimate flags, not bodies/credentials. Images/files/opaque signed or encrypted metadata are explicitly heuristic; 5%-capped-8192 output reserve and 2% margin are heuristics, with explicit larger output caps taking precedence. Unknown window remains unknown.
- `RequestBudgetTracker.predict` completes the **post-step** predictor: most recent full prepared request overhead + production-projected next-message delta + compatible latest input measurement. It conservatively never falls below the corresponding raw estimate merely because a fixture reported tiny measured input. It does not re-resolve Tools. No shadow finalized after is recorded by prediction.
- Prediction is non-authoritative and approximate (SDK role normalization/media overhead/dynamic Tool changes can differ). A shape change forces final rechecking; exact schema changes and current system/options are counted in the final guard. The old cold-history pre-maintenance trigger and its four-pass/two-success policy remain for Task 3, not a final admission decision. Whether that early trigger missed pressure, exhausted its cap, or emitted no progress, the actual request still must pass the final guard.
- Inference-only `wrapLanguageModel.wrapStream` owns final admission before underlying `doStream`; structured compaction and standalone Sampling remain unwrapped. It delegates the same actual SDK params unchanged after admission.
- 75% remains a soft target. After bounded maintenance, an unchanged fitting above-target request can proceed once. Known unsafe, unchanged rejected or larger rejected requests produce a recoverable error with saved input/progress; UI remains available for subsequent user sends. Disabled compaction is never silently enabled and unknown windows are not invented.

## Minimal recovery and execution invariants

- A denied preparation creates an owned stream-local marker containing its fingerprint/budget. Actual installed SDK delivers that marker in an error part; initial result.steps may be generic/no-output. Recovery uses the owned marker, not error text matching or a fabricated successful model-call-end.
- Settle/abortably inspect result.steps, use remembered completed canonical responses, check no pending unaccounted Tool, persist responses with Tool coverage, and mark the segment before maintenance/rebuilding.
- Retire the denied empty coordinator batch through `finishTurn`; do not seal it as successful. Next stream reconstructs from persisted history rather than executing prior calls.
- Existing accepted input ID, cancel/deadline and completed step count span all streams. The denied preparation is not a completed step; maxSteps cannot restart at zero. Real Provider errors after text/tool activity retain conservative no-effect-retry behavior.
- Minimal guard recovery is bounded to four attempts in this batch and memoizes unsafe/soft fingerprints. This is not the Task 3 sustained-success controller or a claim that four is an optimal episode policy. Existing compaction validity/CAS/source evidence/Tool pair safety unchanged.
- Large latest protected Tool output may remain irreducible. In that case necessary input/transcript/ledger remain durable; Provider retry is refused, and explicit subsequent fixture continuation does not rewrite the file or duplicate its exact execution ID. Do not pretend this is an efficiency fix.
- Two settled Tools leave an older compressible result: a successful same-send guard fixture has **one file write, one read, two covered Tool records, three Provider calls, four preparations**, positive same-basis space reduction and final text. The paired maxSteps=2 fixture ends after two Provider calls with `stoppedAtStepLimit=true` and no extra inference.
- Necessary canonical persistence failure after a real local write stops the current turn; review script verifies preserved exact ledger identity and later recovery without writing again. It does not claim the intentionally failed raw Tool row was committed.
- Invalid schedule retry history now spans the whole send (observed StepResult objects deduplicated), not each reconstructed stream. The existing pressure-triggered invalid-loop test caught this real bug. Different user turns still get new retry guards, repaired input is not globally blocked, and no approval/policy rule changed.

## Regression migration rationale

The originally reported 30 Runtime failures were all resolved, not skipped. Original safety tests still assert Tool pair integrity, immutable execution IDs, no replay, accepted-input counts, CAS/SQLite preservation, cancellation and shared step limits.

| Fixture category | Adjustment / retained invariant |
| --- | --- |
| Model switching / pressure turns with 200-token capacity | Use 10k capacity so actual cold system/schema fit, and corresponding 8k step input to retain 75% pressure. Captured finalized budget checked in dedicated suites. No global guard bypass. |
| Engine continuation with file/schema overhead | Use 20k capacity / 16k measured step input; still inject transcript failure only on the second exact Tool occurrence. |
| Reopened long-history evidence batches | Use 100k processing capacity after explicit manual evidence batches, preserving batch generation/count/CAS/readback/no-replay assertions. Tiny 1000 capacity was below the checkpoint/system itself. |
| Historical-estimate-only trigger | Grow actual prior answers and use 40k window; first bounded batch removes six messages, and final admitted full budget is asserted below ceiling. This is not an exact eight-message algorithm promise. |
| Tool-result-only pressure | Grow the actual result to 23k chars for a 10k window so full predictor crosses pressure while final request can fit; keep separate 5000-char no-pressure fixture. |
| Unknown-window automatic overflow recovery | Seed a large older answer so complete request decreases despite reminder growth; keep short-history counterexample requiring zero unsafe redispatch. |
| Cancellation immediately before next dispatch | Expected actual Provider calls now exclude the denied cancelled call. Fixture Provider hangs only before explicitly resuming, so later send cannot accidentally enter an old unreachable hang. Durable Tool/input counts unchanged. |
| Reminder alone exceeds tiny capacity | Deliberate 400-token counterexample now requires recoverable error and zero Provider calls, not inference into known overflow. |
| Semantic duplicate/fallback/workspace persistence | Use real fitting capacity and high measured input/older evidence to force intended compression; preserve duplicate validation/body/no-replay assertions. |
| Runtime server / Core JSON overflow | Increase only prior mock answer size; same interface/protocol and once-only current-turn persistence. No production Core CLI edits for Task 2. |

Intermediate changes were tested group-by-group (18 remaining, then 8, then one scheduling failure, then two short-history Runtime fixtures and one Core fixture). They were not presumed harmless. Two fixture hangs were caused by lower real Provider call counts after cancelling before dispatch; explicit resuming state fixed the test rather than weakening cancellation. All final cases pass.

## Final verification actually performed

Environment: macOS, Node 24.21.0, pnpm 11.24.0, installed AI SDK 7.0.65. Tests use real local SQLite, temporary local files and the installed SDK with MockLanguageModel/controlled transports, **not real subscription inference**.

| Check | Final result |
| --- | --- |
| New Task 2 suites (budget, shared projection, owned guard, boundary, review counterexamples, ordinary/mid-turn refresh, safe continuation) | **23/23 pass** |
| Runtime full suite after final new tests | **1586 total, 1569 pass, 0 fail, 17 platform skips** |
| Core full suite, including original API/subscription/Sampling regressions | **1938 total, 1933 pass, 0 fail, 5 skips** |
| Protocol full suite | **48 pass, 0 fail** |
| Runtime/Core+UI/Protocol typechecks | Passed |
| `pnpm lint` and changed-file fast checks | Passed after conditional-brace fixes |
| Runtime build | Passed, 122 JS files |
| Core/UI build | Passed, 292 JS files and React UI |
| Built CLI `agent health` | Passed; status/readiness only, no host restart or account inference |
| Changeset status | Valid, Task 2 Runtime minor coexists with prior accepted changesets |
| Prettier / `git diff --check` | Passed |

Last edits after full Core/Protocol runs are **test-only** added mid-turn-schema test/condition braces; production unchanged. Runtime full and three-package types were re-run for the new test, then scoped six tests/final repo lint after braces. No needless unchanged full-repo repeat claimed.

Final Runtime + 23专项 + independently supplied probe execution log: `/Users/rensiwen/.roll-agent/bash-output-dumps/1791778222508-session-c671873c-b629-4829-9068-36fa46c377ab.log`. Probe's original historic log was not overwritten. The reproduced script's current output is in that Roll tool log; it confirms the three specific findings are absent on the tested snapshot. This is Roll's actual execution of the reviewer script, **not a new Codex acceptance**.

Full Core E2E not run in this interim Task 2 checkpoint. Actual new-code API/subscription requests not run. No claim about real provider tokenization, latency, universal server acceptance or production net compression efficiency. Phase 1 final E2E/efficiency gates remain.

## GitNexus impact and coverage

- Explicit repository binding: `roll-agent` at baseline worktree. Pre-edit AgentSession file impact traverses Engine/CLI/Runtime, roughly 80 upstream symbols; shared request mutations treated as CRITICAL. RequestBudgetTracker/new source and invalid-schedule guard were followed in source when name resolution failed.
- Final analyzer refresh succeeded (41,026 nodes, 182,719 edges, 1117 clusters, 1047 flows). New tracked/untracked code added to index without staging. Some final test-only additions/formatting happened during the refresh; no final pre-commit freshness all-clear is claimed.
- Structured `detect_changes(scope=all)` on **cumulative Task 1/1a/2 tracked changes**: 20 files, 6 changed symbols, 1031 affected entries, risk **CRITICAL**, `partial=false`, `truncated=false`. Untracked new modules/tests are not git-diff coverage; inspect/index them separately.
- `RequestBudgetTracker` upstream risk CRITICAL/879. `buildSessionModelRequest`, `createInvalidScheduleRetryGuard`, `stopOnContextPressure` still resolve UNKNOWN/not found despite refresh. Text follow-up confirms their definitions/imports and actual AgentSession dispatch/stop path; emptiness is not unused.
- Analyzer reports callable-flow candidate caps, cross-language property omissions, ranked process/depth/branch/walk truncation. Incremental indexed edge growth and inconsistent named-symbol edges remain navigation limitations. Successful detect flags do not erase these global graph gaps.
- One graph query during index rebuilding could not launch due pending DB WAL; no WAL was deleted or lock bypassed. Production source/tests were not treated as verified by that failed query.
- No commit made; future committing agent must perform its own fresh graph gate after independent acceptance.

## Independent acceptance boundary

Deliver Task 2 only for Codex review of calibrated admission vs frozen comparison, owner lifecycle, Provider-rejection full-budget constraint, predictor/actual-schema boundary, canonical persistence and no replay, and migrated fixture safety assertions.

Do not begin Task 3/4 automatically. Existing 32-item evidence order/four-pass/two-pressure-success policy and reminder memory density remain unchanged. Task 2 is reliable request preparation/admission groundwork; it is **not** the promised sustained-pressure/efficiency solution by itself. Stop at idle after reporting; no unfinished background verification or side-effect process should remain running.
