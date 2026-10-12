# Task 2 independent implementation review

Date: 2026-10-12, Asia/Singapore. Baseline: `dev@31816c3a88c250565dafa5032eb9e5d645c7ceb8`.

**Historical status before the incident below: Task 2 independently ACCEPTED after corrective delivery, 2026-10-12.** The earlier REQUEST CHANGES findings and WIP verification below are retained as historical evidence. Acceptance is limited to Task 2; Task 3/4 have not started. No production source edits, commits, pushes, publication, host restart or real subscription calls were performed by this reviewer. Both Codex automations remain paused.

## Acceptance reopened after live half-window interruption

Subsequent status: the user transferred implementation to Codex. The incident correction and Task 3 have local implementation verification in [the delivery report](2026-10-12-context-compaction-task3.md); this is not a new independent acceptance of Codex's own changes. The historic verdict below remains the reason acceptance was reopened.

**Current verdict supersedes the earlier acceptance: REQUEST CHANGES, 2026-10-12.** Independent SDK/AgentSession reproduction now demonstrates a Task 2 liveness regression: opaque encrypted reasoning inflates the heuristic budget, and the fifth recoverable guard pause stops a turn even though its Provider-reported input is 50% of the window and rebuilt requests fit. Pre-Task-2 control completes; Task 2 stops; six completed tools remain unreplayed. See [incident analysis](2026-10-12-context-budget-half-window-incident.md) for the controlled comparison, live-forensics limits and required fixes. Task 3 is now in progress and unaccepted; Task 4 remains unopened. The original acceptance below records the earlier tested snapshot and is not the current overall verdict.

## Corrective delivery acceptance

Reviewed Roll's `2026-10-12-context-compaction-task2.md`, current production source and test migrations; independently re-executed the original reproduction script rather than relying on the author's screenshots or test totals. No remaining actionable Task 2 defect was found on the identified source snapshot.

All three original findings are resolved:

- Ordinary capability/schema refresh: 2 Provider calls; unmatched second request raw/calibrated 2,477, residual 0, ceiling 9,300; second input succeeds. Actual system/schema/Provider-option refresh regression tests also pass. Same-owner maintenance still freezes its comparison residual.
- Unknown-window overflow: 1 Provider call at estimated 1,073 tokens; checkpoint-expanded preparation is refused, current turn ends recoverably. Both overflow error branches retain the rejected budget and exact fingerprint, and final admission requires raw and calibrated net reduction.
- Cancelled maintenance: after remains absent at cancellation; the next send's first preparation does not finalize the old episode. Pending ownership uses accepted-input identity and is abandoned in runTurn finally. Transition observation confirms `oldEpisodeFinalizedByNewTurn=false`.

Original independent positive probes also pass: fitting above-target input dispatches once after bounded maintenance; real temporary-file write remains once with stable SQLite ledger identity; irreducible protected output stops safely; two settled Tools allow successful same-send recovery (3 Provider calls, 4 preparations, 1 write, 1 read, 2 covered records); necessary transcript-persistence failure retains ledger/input and a subsequent turn does not replay the write.

Additional independent production-path predictor probe uses an 11,000-character Tool description and a 12,000-character result. It observes the real predictor without replacing its result or disabling stop/guard. Prediction is 7,804 against a 7,500 soft target, a settled stream is retired, finalized preparation still checks the actual checkpoint-expanded request, and completion has 2 Provider calls / 1 read / 4 preparations. This confirms prepared Tool overhead participates in post-step pressure. The initial exploratory 14,000-character result fixture correctly stopped: its final request was 9,594 against a 9,300 ceiling. That exploratory assertion failure was a fixture capacity assumption, not a production regression; the final probe is retained separately.

Reviewed micro-window migration, larger removable-history fixtures and fault-injection timing against their safety assertions. Once-only input/Skill persistence, canonical Tool pairing or checkpoint representation, durable exact execution IDs, no replay, SQLite/CAS, cancellations and shared step limits remain covered. The invalid-schedule guard now spans the whole send and deduplicates observed steps; the original pressure-continuation regression passes. New guard-specific fixtures that disable prediction isolate the finalized guard; other production-path tests and the additional probe retain both mechanisms.

Independent verification on Node 24.21.0 / pnpm 11.24.0 / installed AI SDK 7.0.65:

| Check | Independent result |
| --- | --- |
| All eight Task 2 suites | 23 passed, 0 failed |
| Complete Runtime | 1,586 total; 1,569 passed, 17 skipped, 0 failed |
| Complete Core | 1,938 total; 1,933 passed, 5 skipped, 0 failed |
| Complete Protocol | 48 passed, 0 failed |
| Runtime / Core including UI / Protocol types | Passed |
| Repository lint | Passed |
| Runtime / Core including UI builds | Passed |
| Built CLI `agent health` | Passed; readiness check only |
| `git diff --check` | Passed |

Evidence: `/tmp/codex-task2-acceptance-{probes,extra,dedicated,runtime,core,protocol,runtime-types,core-types,protocol-types,lint,runtime-build,core-build,cli}.log`; complementary probe source `/tmp/codex-task2-acceptance-extra.mjs`. Original probe source/log were preserved. Local SQLite/file-effect directories are cleaned by the probes. No remote inference or business operation was used.

GitNexus was queried for current request-budget flow/context and cumulative tracked changes: 6 changed symbols, 988 affected entries, 20 files, CRITICAL. The returned change payload exposes summary/symbols/processes and does not supply top-level partial/truncated flags in this invocation; absence is not proof of exhaustive coverage. Untracked new modules and inconsistent graph references require source inspection. No clean whole-repository graph or future pre-commit clearance is claimed.

Acceptance snapshot (SHA-256):

```text
request-budget.ts 9b16afa839b831f2268455b9025bbea7884a4644cf804901bf768ef531ce7182
model-request.ts 5351cb98be9d02950e0f413185be86e3c19d4fb8d38600adec9849ff46bb422c
agent-session.ts b81ba83ea9901260e81d94727adcc1592499de1cd6645678e05f37df52bd906b
invalid-schedule-retry.ts 9ff004ed71e34fb7cf0ae4ce0e2a5186b64180dc7e17904eb91d948dbb754680
```

Task 2 acceptance establishes request projection, heuristic accounting, dispatch admission and bounded handled recovery. It does not certify real Provider tokenization, real subscription requests, full Core E2E, compression efficiency, evidence fairness or Task 3/4. Task 3/4 remain separate authorized implementation/review batches; this acceptance does not automatically launch them. HEAD remains `31816c3`; work is unstaged/uncommitted. Automations `roll` and `roll-chatgpt` were freshly confirmed PAUSED.

## Historical REQUEST CHANGES checkpoint

Roll's earlier WIP report correctly identified an unfinished implementation with failing regressions. The following findings, commands and UI handoff notes describe that earlier snapshot; they are superseded by the independent acceptance above.

## Confirmed findings

### 1. P2: incompatible calibration residual still controls admission after capability/schema changes

`RequestBudgetTracker.prepare` selects `measurement.residual` before it computes shape compatibility. Setting `measurementMatched=false` does not remove that residual from `calibratedInputEstimate`. The actual model-switch path reconstructs the tracker, but capability/system/schema changes do not.

Independent production-path reproduction: create an AgentSession with a 10,000-token window and automatic compaction disabled; complete one request reporting 9,000 input tokens; enable the existing user-input capability with `setUserInputAvailable(true)`; send a small second goal. The new request has a different system/tool shape and is explicitly marked unmatched. Nevertheless, the old 7,999-token residual is added to the new raw estimate of 2,477, producing 10,476 against a 9,300 ceiling. The second request is rejected before dispatch; Provider calls remain 1. This is stale correspondence controlling availability, beyond the deliberate frozen residual used for a same-episode maintenance comparison.

Fix: use compatible residuals for ordinary admission; explicitly separate frozen episode comparison/admission from ordinary correspondence invalidation. Preserve a common before/after basis during maintenance so clearing an unmatched measurement cannot itself manufacture space release. Cover real capability/system/tool/provider-option refreshes, not only model switching and a boolean mismatch assertion.

Evidence: `packages/runtime/src/engine/request-budget.ts`, `prepare`, around lines 188–198; `/tmp/codex-task2-independent-probes.mjs`, case `schema-refresh-incompatible-residual`.

### 2. P2: unknown-window overflow recovery redispatches a larger full request

The provider-rejection guard only checks membership of the exact request fingerprint. The existing context-error recovery treats active-history byte reduction as progress. A new checkpoint changes the fingerprint and can add more model-visible content than the removed history, so unknown capacity bypasses both the capacity guard and the exact-fingerprint check.

Independent reproduction uses the installed SDK, a non-retryable `APICallError` reporting maximum-context overflow, real truncate maintenance, two small older messages and `keepRecentTokens=1`. No recovery method is mocked. The first complete prepared request estimates 1,073 tokens. Truncate removes the small old turn and installs a checkpoint; the next complete prepared request estimates **1,704**. The underlying Provider is nevertheless called a second time. Returning a controlled success on that second call demonstrates that admission actually occurred; it does not establish real server acceptance.

Fix: retain the rejected full-request budget as well as its fingerprint and require a genuinely reduced, comparable projection before automatic redispatch when capacity is unknown. Check the actual next SDK preparation, with a frozen accounting basis, rather than history bytes/checkpoint generation/fingerprint inequality. Otherwise end the current turn recoverably while preserving input and progress.

Evidence: `packages/runtime/src/engine/agent-session.ts`, finalized guard around lines 1704–1729 and overflow continuation around 2200–2221; probe case `unknown-window-overflow-full-request`.

### 3. P2: a new user turn finalizes an interrupted maintenance episode

The tracker is session-wide, while `pending` contains only a budget and has no ActiveTurn/input/episode identity. After cancellation during guarded maintenance, the comparison correctly has no `after`. The next user send's first `prepare` then unconditionally consumes this pending budget and assigns the new request as the cancelled episode's `after`. A later maintenance pass can overwrite that comparison, which makes final-only assertions miss the problem.

Independent reproduction cancels only at the maintenance boundary, asserts absent `after`, restores real maintenance, sends a different small goal and observes tracker snapshots immediately after preparation. The old episode is finalized by the new turn. This example reports -797 saved tokens; it establishes wrong provenance, not a claim of falsely positive space release in this fixture.

Fix: bind a pending comparison and frozen residual to the owning turn/episode; close or abandon it on cancellation/failure without inventing an after-budget. Only that episode's actual guarded re-preparation may finalize it. A later turn must remain usable and must not silently supply missing measurements for an earlier episode. Add a regression that inspects the transition, not merely the latest overwritten comparison.

Evidence: `packages/runtime/src/engine/request-budget.ts`, `prepare` around lines 202–211 and `beginMaintenance`; AgentSession cancellation return following guarded maintenance; probe case `cancelled-episode-new-turn`.

## Independent verification so far

Commands run with Node `v24.21.0`, repository-selected pnpm `11.24.0`, installed `ai@7.0.65`:

- Installed-SDK initial/intermediate rejection probe reproduced: initially 0 Provider calls/0 tools; after one Tool step, 1 Provider call/1 effect/1 remembered step; exact owned marker preserved in stream. This is SDK-boundary evidence, not implementation acceptance.
- Budget unit tests: 4 passed on the reviewed snapshot.
- Input persistence/failure, explicit Skill recovery and tool coordinator regressions: 35 passed.
- Current Runtime typecheck passed after Roll corrected two draft type errors.
- Independent Core (including UI) and Protocol typechecks also passed on the current snapshot.
- Session/Engine regressions: **217 total, 188 passed, 29 failed**. Many failure fixtures declare tiny windows below the newly counted system prompt; their intent and capacity assumptions need migration while preserving original persistence/no-replay/cancellation/step-limit assertions. Do not label every fixture failure as a product regression or remove safety coverage to obtain green tests.
- New budget/guard suite at an intermediate snapshot: 6 passed, 2 failed before exercising the intended path because the new MCP fixtures used an invalid AgentToolSource shape (`tool.inputSchema` was unavailable). Roll is still implementing, so this is a validation blocker to recheck at delivery, not a claimed production defect.
- Follow-up after Roll corrected the MCP fixtures and separated irreducible-output refusal from a later new user goal: the budget/guard suite independently passed **8/8**. The production findings above remain reproducible; passing this suite does not cover them. The earlier 29 Session/Engine failures have not yet been independently reverified after a fixture migration.
- Final checkpoint verification: independently ran all four new budget/projection/guard/boundary files, **13/13 passed**; independently ran the complete Runtime suite, **1,576 total, 1,529 passed, 30 failed, 17 skipped**, matching Roll's WIP report. No old fixture migration has been accepted. Scoped new-module lint, report formatting and `git diff --check` passed. Logs: `/tmp/codex-task2-takeover-dedicated.log`, `/tmp/codex-task2-takeover-runtime-full.log`, `/tmp/codex-task2-takeover-lint.log`.
- Actual AgentSession initial oversized request with compaction disabled: 0 Provider calls, raw input retained, recoverable error.
- Soft-target case: 2 prepared attempts, 1 Provider call, successful turn despite no maintenance space improvement; complete request remained within reserved capacity.
- Actual temporary-file effect followed by an irreducible unsafe next request: 1 write, 1 Provider call, 1 durable Tool record, preserved raw Tool result and identical execution identity after SQLite reopen; current turn ends recoverably.
- Genuine successful continuation after two settled Tools leaves an older safely compressible result: 3 Provider calls, 4 prepared attempts, 1 temporary-file write, 1 read, 2 covered Tool ledger records, final success and positive same-basis space reduction. No completed Tool replay. The non-authoritative predictive stop is bypassed only in this fixture so the finalized guard owns the pause.
- Controlled necessary canonical-response persistence failure after a real temporary-file write: the current turn stops, the accepted input and Tool ledger retain their identity, a later small goal completes, and the write remains exactly once. This does not claim an ordinary raw Tool transcript row was committed by the deliberately failed storage attempt; the durable ledger/recovery path remains authoritative.

Reproduction script: `/tmp/codex-task2-independent-probes.mjs`; output: `/tmp/codex-task2-independent-probes.log`. All created temporary SQLite/file-effect directories are removed in `finally` blocks. Other logs: `/tmp/codex-task2-takeover-regression.log`, `/tmp/codex-task2-takeover-session-regression.log`, `/tmp/codex-task2-takeover-typecheck-current.log`, `/tmp/codex-task2-takeover-guard-tests.log`.

## Scope and remaining gate

The prior chat's user explicitly stopped its reviewer after assigning this chat to take over. Its latest handoff was read, including the residual-invalidation concern. This reviewer independently reproduced the real capability path rather than assuming the standalone tracker concern proves model switching is broken.

GitNexus `detect_changes(scope=all)` reports critical risk for tracked changes (36 changed symbols, 1,036 affected entries, 16 tracked files). Named and UID queries for the pressure method failed with UNKNOWN; concept output contained inconsistent file/symbol labels. New untracked modules are not covered by the tracked-diff/index summary. These are navigation/evidence limits; no clean whole-change graph verdict is claimed. Source and installed SDK inspection supplement the graph. The shared AgentSession dispatch/recovery path remains a critical review area. No production symbols were edited by this reviewer.

Still required at stable delivery: fixes and focused counterexamples for the findings; correct passing guard/model-request fixtures; request projection including Skill/checkpoint/options and dynamic description/schema without extra resolvers/downloads; deadline/cancel/maxSteps/batch cleanup; appropriate Session/Engine regressions; Core/Runtime/Protocol typechecks, scoped lint and necessary builds. Full Phase 1/E2E, real subscription acceptance of these changes and compression efficiency are outside these interim results. Task 3/4 must not start before Task 2 independent acceptance.

Continuation direction: fix the three reproduced production contracts first; finish the shared complete-request predictor and step-current correspondence; then migrate each affected micro-window fixture with a captured full-request budget while keeping its original semantic/persistence/approval/maxSteps assertions. Do not globally bypass the guard, skip failing cases, relax Tool/evidence protections or start Task 3 controller changes to obtain a green Task 2 suite. The protected latest-result refusal is valid; the separate two-settled-Tool reproduction supplies a real same-send success case. Finish this authorized corrective Task 2 batch, report actual verification and stop for the next independent review. This is engineering feedback under the existing implementation authorization, not a new end-user approval gate.

UI handoff status: the stopped WIP result and empty Roll prompt were visually confirmed before preparing feedback. Metalterm accepted a draft at one point, but subsequent keyboard actions had inconsistent visible effects and Computer Use repeatedly reported that the app had changed and required a fresh observation. The duplicate unsent draft was later visibly cleared. Rebinding/resetting the Computer Use control session did not establish a reliable submission receipt. No feedback acceptance or resumed Roll execution is claimed. The report and reproduction evidence are ready; continuation still needs a confirmed message in the existing idle Roll session. The control connection was reset, not the Roll process. No execution-time prompt insertion, process restart, model change or automation resumption was performed.

Snapshot hashes when findings were recorded:

```
request-budget.ts cd98c62a2a1a8b105716cba494173fca659d59703693f40b8c0a79c4a8367139
model-request.ts 5351cb98be9d02950e0f413185be86e3c19d4fb8d38600adec9849ff46bb422c
agent-session.ts 06184d58d9a3088b8421acb7ab487dfd0b93a1f8ecc6d674c2a868fbb1abfbf6
```
