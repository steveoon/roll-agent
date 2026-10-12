# Task 2 — Unfinished Implementation / Failing Regression Checkpoint

## Status

**Historical failing checkpoint, superseded by the corrected local delivery:** `docs/reports/2026-10-12-context-compaction-task2.md`. Preserve the original results below; do not interpret them as the final current status. Independent acceptance is still required.

**WIP, NOT acceptance-ready (at the time of this original checkpoint).** Task 1/1a were independently accepted. SDK revision section 6 approved Task 2 implementation, which has begun. Runtime full regression is currently failing; this report is not a successful delivery or a request to silently broaden scope. Task 3/4 are untouched. HEAD remains `31816c3`; all prior accepted and current WIP edits are uncommitted/unstaged. No push, publish, current-host restart or model/thinking/approval-setting change.

## Implemented draft

- `engine/model-request.ts` extracts the actual Roll message projection used by inference: metadata stripping/recovery materialization, current Skill snapshot, capability/checkpoint context, observation projection and Tool-image relocation. SDK remains the only actual schema/description/prompt preparation.
- `engine/request-budget.ts` estimates the finalized SDK prompt/system/tools/options, retains raw/calibrated numbers and labels opaque/multimodal estimates. Stable fingerprinting includes actual prepared schema/description/system/options and Skill/checkpoint shape context. Reserves are heuristic, not provider acceptance guarantees.
- Inference-only public `wrapLanguageModel` guard blocks before underlying `doStream`. Structured compaction and standalone Sampling remain unwrapped. Known capacity failures become an owned stream-local control marker, not an unhandled Provider error. The 75% soft target does not hard-reject an admissible prompt.
- Minimal recovery remembers/persists canonical completed steps and Tool coverage before bounded maintenance/re-preparation, retires the denied empty coordinator batch without fabricating a successful model-call-end, and retains overall cancellation/deadline/completed-step counters.
- Same unsafe fingerprints stop recoverably. Unchanged soft-state attempts are memoized. Initial four guarded recovery attempts per send is a WIP bound separate from the existing Task 3 controller; not a claim of final optimal maintenance policy.
- `RequestBudgetTracker` freezes residual through the next finalized guard; cancellation/failure before re-preparation leaves after budget absent. Exact correspondence and conservative residual are distinct; raw request growth cannot count as shrink due to a residual reset.
- Latest input usage replaces the earlier maximum in context reporting. Cumulative usage remains billing. Engine passes known window source through creation/model switch; unknown capacity remains unknown and disabled maintenance stays disabled.
- Invalid-schedule retry guard moved to whole-send scope so a guard-driven stream restart cannot reset its rejection history. All genuine Provider failures still follow existing conservative handling.
- Numeric process-local `getRequestBudgetState()` is not Task 4 persistent diagnostics or a public Runtime wire event.

## Verification actually performed

| Check | Result |
| --- | --- |
| Runtime typecheck after final edits | Pass |
| Core/UI and Protocol typecheck after recovery/budget edits | Pass |
| New budget/projection/guard/boundary suites | **13 tests, 13 pass, 0 fail** |
| First Runtime full run | 1571 tests: 1523 pass, 31 fail, 17 skip |
| Final Runtime full run | **1576 tests: 1529 pass, 30 fail, 17 skip** |
| Fast verify changed production files and new tests | Passed |
| Core full tests / Protocol full tests / builds / Core E2E | Not run for this WIP batch; do not inherit earlier accepted-batch results |
| Actual subscription inference | Not run; all inference tests use installed SDK with controlled Provider |

Final full failure output: `/Users/rensiwen/.roll-agent/bash-output-dumps/1791774996569-session-40f01058-26f7-4d48-8f22-b97c0bf161f1.log`. New dedicated fixture initially had the wrong `SourceTool`/Client shape, now fixed; production strict types pass. That fixture error is not a product failure.

### What the 13 passing tests establish

1. Prepared system/message/schema/options components are counted without an independent SDK conversion. Dynamic callable descriptions are resolved only by SDK (two resolutions in that SDK fixture; budgeting does not add a third).
2. Explicit output cap reserve and unknown window behavior; binary/opaque estimate flag.
3. Exact dispatched latest input usage replaces earlier larger residual; cumulative billing is not occupancy.
4. Same/larger payload after checkpoint/shape change does not gain space from residual reset.
5. Initial guard makes zero underlying Provider calls; bounded preparation and next send work after deliberate fixture capacity change.
6. Soft-target miss within available capacity dispatches once after maintenance, not a perpetual repeat.
7. Actual temporary-workspace write occurs once; guard persists one Tool result and one exact ledger execution identity/coverage before maintenance; subsequent explicit fixture continuation does not replay the write.
8. Owned guard maintenance cancellation/timeout/failure leaves finalized after absent and accepted input reusable.
9. Disabled compaction performs no maintenance or unsafe known-window dispatch; unknown capacity is not fabricated.

The large latest Tool result test **does not prove same-send successful shrink**. Existing compactor protects the latest Tool group (`trailingStepStart`/`truncateToolResults`); it cannot release that payload in this fixture. The test asserts preserved once-only evidence, safe recoverable stop, and later explicitly continued inference without replay. That preserves existing policy rather than introducing Task 3 behavior prematurely.

## Unresolved regressions and missing acceptance coverage

The 30 full-suite failures are concentrated in:

- AgentSession model-switch and historical pressure tests with window values 1/200/300/400 that never counted cold system/schema overhead.
- Whole-send legacy pressure continuation/error/cancel/overflow/maxSteps/duplicate-ID fixtures. Many abort before their intended tool path because actual complete request is now correctly above those micro-windows; they must be migrated individually with realistic full-request capacity and distinct measured-pressure signals, not bypassed or globally weakened.
- Checkpoint-only pressure, cumulative-vs-context and workspace-instruction tests that similarly expect inference despite mandatory request overhead.
- Engine earlier-long-turn catch-up and segment-storage-failure tests; cannot assume all are fixture-only. The interaction of bounded guard recovery, existing four-pass/two-continuation policy, checkpoint overhead and preserved evidence needs direct inspection.
- Schedule recovery fixture; registry/runtime rules cannot be allowed to reset on restart. Moving its guard lifetime does not yet make its micro-window test reach the intended path.

**Do not classify all failures as harmless fixture changes.** Shared high-risk behavior needs concrete before/after captured request budgets and ledger invariants for each migrated scenario. No existing failing assertions were skipped/removed or bulk-edited in this continuation.

Remaining Task 2 work includes:

- Finish the complete-request post-step predictor (currently the old message-only predictor remains as a non-authoritative stop trigger; final dispatch guard is authoritative).
- Capture step-current shape context, dynamic schema/workspace/tool refresh and provider-options changes with request-specific measurement pairing across actual continuation.
- Verify no deadline/step-budget reset over several guarded stream rebuilds, no false success from rejected promises, and pending/unknown effects conservatively handled.
- Add genuine same-send successful maintenance/reprepare with older compressible evidence and no replay, independently of the protected-latest-result fixture.
- Test unchanged provider-confirmed overflow fingerprint blocking through all Provider-error branches, SDK retries/asset preparation costs and schema-only pressure.
- Decide/validate conservative residual behavior when exact measurement shape mismatches; retain consistent comparison without letting an old high residual falsely imply an exact measurement for a smaller new shape.
- Resolve the 30 failures, then run changed Core/Runtime/Protocol regression, lint, builds/CLI, fresh graph checks and final delivery report. New changeset `.changeset/context-request-dispatch-budget.md` is a draft, not publication.

## GitNexus risk and safety

Explicitly bound `roll-agent` worktree, base/index `31816c3`. Pre-edit file-level AgentSession impact reports 80 upstream symbols and Engine/Runtime/CLI consumers. Symbol impacts for request pressure/recovery report CRITICAL with inconsistent broad edges from the previous index. UNKNOWN/ambiguous methods were followed up in source; these results were not used as low-risk permission.

Reviewed real chain: `runTurn → streamText/prepareStep → finalized wrapStream → owned stream error → remembered canonical steps/Tool coverage → maintenance → new stream`, plus Engine window resolution callbacks and coordinator start-without-end cleanup. Current new modules are not yet in a fresh finalized graph; no final detect_changes/pre-commit all-clear is claimed. A full graph refresh is deferred until implementation/regression stabilization, not a substitute for tests.

## Checkpoint boundary

Following the execution-plan rule to stop when verification repeatedly fails, this is an unfinished engineering checkpoint. Production WIP remains visible for review, not installed into the running host and not committed. Independent Codex can inspect the failure classification/fixture migration direction before the next continuation. This does not request a new end-user approval or authorize Task 3/4, and does not claim Task 2 is done.
