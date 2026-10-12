# Context Compaction Reliability — Phase 1 Design and Implementation Plan

> **For agentic workers:** After the independent design checkpoint passes, use `executing-plans` to implement task-by-task, with tests and review checkpoints. Do not commit, push, publish, or change the already committed thinking feature. Checkbox completion is evidence-based, not a claim that this design has already been implemented.

**Goal:** Accept and preserve user input independently of context maintenance; make long-running tool turns recover context pressure without losing protection, replaying side effects, or concealing failures.

**Architecture:** Keep the existing append-only transcript, typed Tool ledger, structured semantic-state validator and transactional/CAS checkpoint installation. Add an exactly-once accepted-input boundary, a shared actual-request projection/budget layer, and a bounded maintenance controller whose evidence progress and space progress are distinct. Persist content-free diagnostics through ConversationEngine/ThreadStore, including CLI sessions, rather than relying on Runtime events or debug output.

**Tech Stack:** TypeScript ESM/type stripping, AI SDK 7.0.65 / LanguageModelV4, Zod, Node `node:test`, SQLite `DatabaseSync`; Node >=22.13.0, pnpm 11.24.0. Observed local tools: Node 24.21.0, pnpm 11.24.0.

**Spec:** The coordinating review request in this conversation, 2026-10-10: Phase 1 reliability first; Roll designs/implements, Codex independently reviews/accepts. This document is both the concrete design and its execution plan. Baseline `31816c3a88c250565dafa5032eb9e5d645c7ceb8`, branch `dev`, worktree `/Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent`.

## 0. Review gate and non-goals

- Status: **Task 1/1a accepted; Task 2 incident correction and Task 3 implemented and locally verified by Codex, awaiting user acceptance.** The user reassigned implementation from Roll to Codex on 2026-10-12. The staged Task 3 contract remains in force; see `docs/reports/2026-10-12-context-compaction-task3.md` for final implementation, tests and limits. The earlier independent Task 2 acceptance was reopened by the half-window incident and is not silently reinstated by the implementer's self-verification. Task 4 and Phase 2 remain gated; automations remain paused; no current Roll host restart or settings change.
- User input must not be disabled or rejected at the UI because of context occupancy. Internal inference can end with a recoverable, explicit error when the preserved input cannot be processed safely.
- Retain existing active-turn concurrency/approval interaction behavior; this phase does not add a queue for simultaneous user turns.
- Do not change `runtime.compaction.threshold` default 0.75, thinking effort mappings, subscription authorization, Sampling routing, or model catalog values.
- Do not add post-response automatic maintenance or background model calls. A final reply can leave pressure for the next input; next-request handling must reliably preserve that input.
- Do not redesign summary semantics, shrink semantic quotes, enlarge the 32-evidence prompt cap, remove provenance validation, or introduce a service-side remote compaction protocol. Memory density/throughput tuning belongs to Phase 2.
- No credentials, extra chat bodies, Tool result bodies, Skill bodies or system/tool schemas in diagnostic storage. Existing transcript/ledger redaction rules continue to apply.
- No dependency additions, automatic provider/channel fallback, commits, pushes or publishing. Related changesets are required at delivery, not actual release execution.
- Unknown effects are not treated as low risk; HIGH/CRITICAL findings require explicit warning and independent review.

## 1. Verified current behavior and limits of the diagnosis

Source anchors below refer to the baseline, not to line numbers after implementation.

| Current behavior | Verified location | Phase 1 consequence |
| --- | --- | --- |
| `runTurn` reconciles Tool context and auto-compacts before appending the new user message | `packages/runtime/src/engine/agent-session.ts:1478-1606` | Compression error can return before the new input reaches transcript; persistence boundary must move ahead of maintenance. |
| `prepareStep` builds the actual projected model messages; system/tools and ephemeral contexts are assembled separately | `agent-session.ts:1591-1679` | Reuse this request path; do not estimate only raw active history. |
| Last step's input usage is used in pressure logic, but fullStream tracking can retain the maximum input usage rather than the most recent request | `agent-session.ts:1910-1918, 2142-2149, 2710-2759` | Associate each measurement with that request's own projection and use the latest successful request, never turn/session cumulative usage. |
| At most two successful pressure continuations; one no-progress attempt sets the counter directly to the maximum | `agent-session.ts:435-437, 2163-2195, 2710-2723` | Remove the whole-turn cap; bound maintenance work and unchanged-state retries instead. |
| Four automatic passes are currently the entire loop; boolean result conflates different progress kinds | `agent-session.ts:2677-2707` | Four becomes a cooperative scheduling quantum, not permission to resume an over-budget model request. |
| A model evidence prompt presents at most 32 items; registry order is messages, then Tools, then resources | `compaction-semantic-state.ts:685-763`; `agent-session.ts:3034-3058` | Mixed backlog can starve the Tool evidence lane; add bounded, deterministic fairness without expanding the cap. |
| Raw-message removal is capped at a contiguous presented message prefix; semantic watermarks advance only through actually covered entries | `agent-session.ts:3234-3317`; `compactor.ts:319-338` | Preserve this safety property; support coverage-only intermediate checkpoint progress. |
| `runCompaction` already checks decreasing active-history UTF-8 bytes, but not complete request size including the newly installed reminder | `agent-session.ts:3540-3610` | Do not describe it as having no shrink test; add full-request budget progress separately. |
| Generic semantic reminder defaults to 16k characters; production checkpoint uses an 8k semantic sub-budget inside a 32k overall reminder bound | `compaction-semantic-state.ts:54-58`; `compaction-checkpoint.ts:474-481` | Preserve these existing bounds in Phase 1. They do not guarantee a particular total request cost. |
| Checkpoint + replacement history + lineage/range validation use `BEGIN IMMEDIATE` and CAS | `store/thread-store.ts:2311-2506` | Preserve atomicity and append-only raw transcript/Tool evidence; no model call from inside a DB transaction. |
| `context-compacted` exists in SessionEvent, but Runtime service discards compaction/step events from its public projection | `types/events.ts:94-129`; `service/runtime-service.ts:1680-1686` | Persistent diagnostics must be bound at Engine/Store, independent of UI/event subscription. |

Independent review reported 10 checkpoint generations, roughly 3.6–3.8k reminder tokens per generation, a 32-message semantic-watermark increment and Tool watermark `-1`. These are observations to reproduce in an isolated fixture, **not proof of a particular root cause of the first task**. The missing historic per-step diagnostics prevent a complete retrospective causal proof.

A compacted checkpoint's generation advancing is not evidence that budget improved. A true Tool outcome does not imply that the whole user task is complete. Valid source quotes do not validate every model interpretation.

## 2. Input acceptance: preserve exactly once before maintenance

### 2.1 Ordering and durability

At the start of an accepted `send`, after ordinary input/attachment normalization and active-turn ownership checks:

1. Assign a stable internal `inputId` to this invocation. It survives all maintenance/recovery continuations of this send. It is not regenerated per stream attempt and is not based on prompt text; identical text in two explicit sends is two inputs.
2. Start the existing overall turn deadline before work that can block. Persist the normalized raw user message and an acceptance receipt **before** reconcile, asynchronous dynamic context, compression, or inference.
3. After the persistence transaction succeeds, install the user message in in-memory active history and mark `userMessagePersisted=true`. Update segment bookkeeping to exclude the already persisted user message from subsequent message appends.
4. Prepare the explicit Skill snapshot once. Its body remains ActiveTurn-local as today. Store only selected names, reference hashes and Skill-checkpoint version with the receipt; neither the Skill body nor a second copy of `userPrompt` belongs there. Do not add a second transcript user message or mutate the append-only raw message to attach metadata later.
5. For compatibility, read legacy `explicitSkillCheckpoint` message metadata as well as new receipt-side metadata. Checkpoint construction consults the accepted input's Skill refs; actual model materialization consumes only the current ActiveTurn snapshot, never stale historical Skill bodies.
6. Reconcile uncovered Tool execution records, build capability context, and run maintenance against the full upcoming request, now including the accepted input.

If explicit Skill loading fails, the raw input has still been saved; report the existing Skill error without calling the model. If acceptance storage itself fails, report `input_persistence_failed` and **do not claim the prompt was saved** or start inference. In no-store AgentSession mode, use a process-local receipt and existing in-memory transcript, explicitly without promising crash durability.

### 2.2 Storage and idempotency

Add a small `thread_turn_inputs` table, not a duplicate prompt journal:

```sql
CREATE TABLE IF NOT EXISTS thread_turn_inputs (
  thread_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  transcript_sequence INTEGER NOT NULL,
  skill_checkpoint_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, input_id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);
```

- `acceptTurnInput(threadId, inputId, message)` atomically appends to the existing `messages` and `transcript_messages` tables and inserts the receipt. Reusing the same receipt returns its existing sequence; it does not append again or reinsert a message dropped by compaction.
- This internal idempotency is **not** a new public cross-process exactly-once turn-execution guarantee. Runtime's own request/turn identity and deduplication remain authoritative for public retries. Reloading history does not dispatch an old input as a new send.
- `recordTurnSkillCheckpoint` is an idempotent receipt metadata update. Its storage schema picks the version/kind and `skillNames`/`skills` reference fields from the existing sanitized Skill schema, excluding `userPrompt` and `modelUserContent`. When needed, recover the parsed prompt from the accepted raw slash input using existing invocation parsing, not another stored prompt copy. Reading metadata does not mutate the raw transcript. The argument may accept `ExplicitSkillCheckpointV1`, but the writer validates and stores only this selected subset.
- Manual compaction without a user send creates no input receipt.
- Cancellation, timeout, errors and overflow recovery all consult the receipt/userMessagePersisted flag. Only unpersisted response steps/recovery markers are appended. Audit and adapt `turnStart`, `splice(turnStart)`, `markTurnSegmentPersisted`, `persistContextFailure`, `persistFailedTurn`, `persistCancelledTurn` and `appendInterruptedTurnMessages` together; rollback must never remove the accepted input from either durable or in-memory active history.
- On resume, load accepted raw input normally, preserve diagnostics, reconcile uncovered Tool results as today. No automatic replay of prior Tools or stale task authorization.
- The newest accepted user message and its current Skill context are protected from silent clipping/removal by maintenance. A single uncompressible oversized input is preserved and produces a recoverable processing error; a later smaller input can replace the active goal and permit old content to be compacted under existing evidence rules.

Proposed interfaces, schema-derived where applicable:

```ts
// store/turn-input.ts; new types derive from Zod receipt/input schemas.
acceptTurnInput(threadId: string, inputId: string, message: UserModelMessage): AcceptedTurnInput;
recordTurnSkillCheckpoint(threadId: string, inputId: string, checkpoint: ExplicitSkillCheckpointV1): void;
getTurnInput(threadId: string, inputId: string): AcceptedTurnInput | undefined;
```

`AgentSessionOptions` receives `onAcceptInput` and `onRecordInputSkillCheckpoint`; ConversationEngine supplies Store implementations. The existing `onPersist` still handles responses and Tool coverage. No new UI form, confirmation prompt, or public send method is required.

## 3. Actual-request projection and budget

### 3.1 One production message construction path

Extract `buildSessionModelRequest` into `engine/model-request.ts`. It returns an immutable snapshot of the system/instructions, effective filtered Tool set, projected messages, provider options and a request-shape epoch. It uses the existing production transformations:

- cancellation recovery materialization;
- stripping persisted Skill/cancellation metadata;
- applying the same ActiveTurn Skill snapshot once;
- capability reminder + current checkpoint reminder;
- canonical Tool observations and historical observation projection;
- Tool-image relocation;
- current accepted input and already completed steps;
- refreshed system/workspace instructions and effective Tool schema policy.

The result is used by both `streamText`/`prepareStep` and budget computation. Build/cache the effective Tool schema view from the exact `modelTools()` result, not the agent registry's unfiltered catalog. Resolve SDK schemas using its installed public schema utilities; cache only by schema/tool epoch and invalidate on agent refresh/model policy change.

Implement a narrow `LanguageModelV4` wrapper/middleware at the **inference `streamText` model argument** to inspect the **final provider-neutral call parameters** immediately before `doStream`. This verifies that the SDK-converted prompt/system and Tool schemas are all counted and catches any projection/conversion drift before network dispatch. It delegates the unchanged call to the original model only after admission. Do not replace `this.model` with this guarded wrapper: `compactMessages` currently uses that underlying model too, and a guard on the shared field could recursively guard the compaction request itself. Standalone Sampling, auth and thinking options remain unchanged.

The estimator has a single component-counting core with adapters for the shared logical snapshot and finalized `LanguageModelV4CallOptions`. Both views are labeled estimates, and the final-call adapter is authoritative for dispatch. Log component totals/drift, not the parameters themselves. No approximate clone of the production history pipeline is permitted.

### 3.2 Budget snapshot and calibration

`engine/request-budget.ts` defines a strict Zod schema and `RequestBudgetSnapshot = z.infer<typeof requestBudgetSnapshotSchema>` containing:

- window + source (`override/catalog/rule/unknown`), provider/model identifier, request epoch;
- estimated projected message/system/Tool-schema token components; non-text or opaque-part estimate flags;
- most recent successful step's measured input usage and its matching request estimate, if available;
- estimated calibrated input, output reserve, estimate-error reserve, available input ceiling and 75%-based maintenance target;
- `estimated=true`, calibration availability and accounting version.

The system and schemas are counted from the same effective request. Reminder and Skill content are already inside those messages; expose their breakdown only by replacing/subtracting their own segments, never count them a second time.

```text
rawInputEstimate = estimate(actual model-visible prompt + system + Tool schemas)
calibrationResidual = latestMeasuredInput - matchingRawInputEstimate
negativeResidualScale = min(1, rawInputEstimate / max(1, matchingRawInputEstimate))
compatibleCalibrationResidual = matched ? residual * (residual < 0 ? negativeResidualScale : 1) : 0
calibratedInputEstimate = max(0, rawInputEstimate + compatibleCalibrationResidual)
outputReserve = min(8192, max(1, floor(window * 0.05)))
errorReserve = max(1, ceil(window * 0.02))
availableInputCeiling = max(0, window - outputReserve - errorReserve)
maintenanceTarget = min(floor(window * configuredThreshold), availableInputCeiling)
```

These reserves are internal admission estimates, **not provider `maxOutputTokens` settings**, fixed reasoning-token budgets, UI restrictions, or a change to the 75% default. They are explicit Phase 1 starting policies for independent review. If an actual request has an explicit larger output cap, reserve at least that cap instead of silently assuming 8192 is sufficient. Use proportional values in tiny-window tests; test reserve math separately.

2026-10-12 incident amendment: signed residuals correct demonstrated heuristic overestimation. Opaque payload digests participate in matching so their discount cannot transfer to replacement ciphertext or plain text. Ordinary user text is history, not a configuration-epoch change. Maintenance before/after uses the fixed episode residual separately from the live admission residual, and requires raw request shrinkage for positive space progress. This supersedes the original one-sided calibration formula.

The 75% maintenance target is advisory, **not a hard validity limit for user prompts**. Initially attempt maintenance above it. If bounded maintenance cannot reach that target but the finalized complete request still fits `availableInputCeiling` and is not a provider-rejected fingerprint, it may proceed once with an `above_target_but_admissible` diagnostic and memoized soft-trigger handling for that state. A new Tool result/shape change re-evaluates pressure. Fail processing only when the full request remains inadmissible or evidence/protocol/persistence safety cannot be established, not merely because the prompt occupies 76% of the window.

- Use the latest successful request's `inputTokens`, including cached input as occupancy. Never use `totalUsage.inputTokens`, session cumulative consumption, or the largest input from an earlier request as the current measurement.
- Do not add all reasoning/output usage as replayable history. Count only content actually present in the provider-neutral next request; opaque/signed fields remain estimates.
- Reset precise measurement correspondence on model/channel changes, system/schema/Skill epoch changes and checkpoint installation. Preserve raw and calibrated estimates separately. Freeze a common calibration residual for maintenance before/after comparisons; a residual reset cannot count as payload/space reduction or alone prove restored admission. If the model changes, comparisons are marked incomparable until a valid measurement exists. Resumed sessions start honestly as estimated unless a matching persisted measurement can be validated. Regression: unchanged/larger payload with residual reset must never be reported as space progress.
- For unknown windows, record `unknown`, do not invent a window. Keep ordinary requests working; on a provider-confirmed overflow remember its request fingerprint and require a different, reduced projection before retry.
- With auto compaction explicitly disabled, do not silently re-enable it. Still preserve input and prevent automatic repeat dispatch of a provider-confirmed oversized fingerprint; report current-turn processing errors without locking future input.

Admission outcome is internal:

```ts
const REQUEST_ADMISSIONS = ["ready", "maintenance_required", "unrecoverable_input"] as const;
```

A `maintenance_required` outcome is a host control signal, not a provider failure or UI refusal. If the internal budget remains unsafe after bounded recovery, emit an existing `SessionEvent` error with a stable reason code and a message that the input/progress were preserved; end this turn and leave the session usable.

### 3.3 SDK safe point

The installed SDK calls `prepareStep` before its provider request and checks stop conditions only after client Tool calls have outputs (`ai/src/generate-text/stream-text.ts:1931-2015, 2424-2453`). Its exceptions can become stream error parts, not synchronous exceptions from `streamText`.

- Normal path: the existing post-step stop condition checks the next shared request budget and requests maintenance after Tool settlement.
- Last-chance path: the finalized-call wrapper marks an ActiveTurn-local, typed `ContextMaintenanceRequired` control reason and refuses **that network dispatch only**. The outer driver must recognize the owned marker through SDK error/stream wrapping, not by substring regex. Keep marker state outside untrusted Tool/model text.
- Before maintenance, consume/settle the SDK stream, retrieve remembered completed steps, persist unpersisted canonical responses and Tool coverage, and verify no pending Tool occurrence is being treated as completed.
- Do not take the existing generic `streamError -> splice(turnStart)` path for this internal pause. Do not count the rejected pre-dispatch attempt as a completed model step or reset the overall turn timer.
- Reconstruct a new SDK stream from persisted history after maintenance. Tools already executed are not replayed; only the next inference request is generated. Real provider errors with any side effect/output retain the existing conservative no-automatic-retry semantics.
- Keep overall maxSteps, cancellation, deadline, user rejection, scheduling guards and batch coordinator behavior. Stopping for maintenance must not create a new public Runtime turn or renew task authorization.
- An Agent install/refresh or Tool-policy epoch change during a tool step may require a safe request rebuild even without pressure. Rebuild at the settled boundary with the actual new Tool set; do not mutate an SDK stream's old Tool snapshot in place. Record `request_shape_changed`, avoid unnecessary summary calls, and re-budget the rebuilt request.

## 4. Evidence batching: 32 items, four-pass quantum, no starvation

### 4.1 Fair selection without losing coverage safety

Keep `MAX_MODEL_EVIDENCE_ITEMS=32`, per-evidence excerpts and the 48k-char production evidence budget. Change **selection order**, not summarization authority:

- Maintain separate oldest-uncovered message and Tool lanes, each in sequence order.
- Present the current goal when it is outside those lanes, then alternate oldest message / oldest Tool. When both lanes exist, try to include at least one from each before allocating more. A fitting invariant test fails if one lane repeatedly gets zero items despite capacity.
- One lane can use unused slots when the other is empty. Resources fill spare slots after the two continuity lanes; they cannot prevent message/Tool watermark advancement. Retain existing authoritative resource/runningWork state regardless of model prompt selection.
- Previous semantic goal/state keep the current bounded projection rules. Never mark evidence covered just because it was selected; only validated references/reviews, or existing safe deterministic fallback coverage, advance the appropriate watermark.
- If an oldest entry cannot fit even after the existing bounded excerpt rules, record `evidence_unpresentable` and terminate maintenance rather than skip it, forge coverage or keep generating the same draft.
- Both watermarks remain contiguous. Message removal still respects the presented/validated prefix and Tool-call/result boundaries. Tool coverage never grants permission to fabricate a successful outcome.

Add `selectCompactionEvidenceBatch` as a pure helper in `engine/compaction-evidence-batch.ts`. `captureCompactionEvidence` calls it before `buildCompactionSemanticModelContext`; the final `includedEvidenceIds` remains the authority for what the model actually saw. Tests enforce fairness after character limits, not just after the item-count selector.

This is a Phase 1 starvation fix, not a claim that equal alternation is the optimal throughput policy. Phase 2 can tune priorities/budgets based on real diagnostics.

### 4.2 Two independent progress dimensions

Replace the boolean result of `runCompaction` with a staged `CompactionPassResult` from `engine/compaction-recovery.ts`. **The immediate-before/after sketch below is historical and superseded by the approved 2026-10-12 staged contract.** The installed/no-commit result carries only committed history/coverage and checkpoint identity; the owning pass gains finalized after only at the next actual SDK preparation. See `2026-10-12-task3-finalized-episode-checkpoint.md` and the Task 3 final report.

```ts
const COMPACTION_PASS_KINDS = ["space_progress", "coverage_progress", "no_progress"] as const;
// Type derived from constants/schema, no parallel hand-maintained string union.
interface CompactionPassResult {
  readonly kind: (typeof COMPACTION_PASS_KINDS)[number];
  readonly before: RequestBudgetSnapshot;
  readonly after: RequestBudgetSnapshot;
  readonly coverageBefore: CompactionSemanticEvidenceWatermarks;
  readonly coverageAfter: CompactionSemanticEvidenceWatermarks;
  readonly checkpointGeneration?: number;
}
```

Define progress precisely:

- **Coverage progress:** at least one contiguous message/Tool watermark advances. Can be committed with unchanged active messages after source/coverage validation. A new checkpoint ID/generation alone is not progress.
- **Space progress:** complete calibrated input estimate shrinks. For controller reset, require material reduction aggregated from the episode baseline: `max(256 tokens, ceil(baselineInput * 0.005))`, capped proportionally for tiny test windows. A one-byte/one-token decrease does not repeatedly renew maintenance costs.
- A byte reduction of active history remains useful diagnostics, but cannot authorize inference if the newly installed reminder causes total request budget to stay high or increase.
- Some validated intermediate batches may grow reminder size while advancing coverage. Permit them within the episode cost bounds; record a negative `savedTokens`. Do not claim space was released, and never resume inference merely because coverage advanced.

`prepareSnapshot` and `compactMessages` must support coverage-only candidates; today both favor removed/truncated active-message results. Keep all semantic/source validation, Tool protocol repair rules, V1 migration coverage and Store CAS checks. Commit a coverage-only candidate with the same active history and a new validated checkpoint/watermarks; no SUMMARY/ACK copies in active history.

Post-install, build the full request using the **actual returned checkpoint**, not a guessed reminder. Compute and persist `after` with the same accounting version/epoch as `before`. No inferred exact saving from raw JSON bytes; after installation is still a calibrated estimate, not a new measured provider usage.

### 4.3 Bounded maintenance episodes

A maintenance episode is one interruption of inference to restore request budget. It ends on readiness, explicit recoverable failure, cancel or turn timeout. It is not the whole user turn.

- Remove `MAX_CONTEXT_PRESSURE_CONTINUATIONS=2` and its exhaustion assignment. Unlimited *successful* episodes are allowed within existing turn deadline/maxSteps; each new tool result can legitimately require another one.
- Keep four passes as a scheduling quantum. Yield the event loop after a quantum while continuing the **same episode**, with unchanged counters/deadline; this is not permission for a model call or a reset of the maintenance cost budget.
- Shared episode provider deadline: `min(settings.timeoutMs ?? 120000, remainingTurnMs)`; each `generateCompactionDraft` receives only the remaining timeout, including its existing internal retry. A chunk may not restart the 120s timer.
- Explicit request-cost ceiling: derive an initial draft-call budget from the uncovered message/Tool backlog under fair batching, with a hard ceiling:

```text
laneBatchEstimate = max(ceil(uncoveredMessages / 15), ceil(uncoveredTools / 15))
maxDraftCalls = min(32, max(4, laneBatchEstimate + 2))
```

Fifteen per lane leaves two of the 32 slots for goal/boundary overhead when both lanes are occupied. This is a conservative cost bound, not an assertion of actual batch throughput. The 32 hard ceiling and episode deadline are deliberately reviewable. They do not change the evidence prompt cap or create a whole-turn success limit. Count **actual provider requests**, including internal draft retries, not just loop iterations.

- Maintain state fingerprints excluding volatile timestamps/checkpoint UUIDs. Include canonical active-projection digest, semantic-watermark pair, semantic-state/reminder digest, request-shape epoch and current protected input identity.
- A repeated equivalent state ends maintenance with `maintenance_no_progress`; at most one deterministic truncation fallback for the same state, and no additional identical summary provider request. If the finalized request is independently admissible, report the advisory target miss and continue once; otherwise return the recoverable processing error. When many different states advance only tiny bytes with no coverage and no material aggregate reduction, exhaust the finite episode call/deadline budget without resetting it.
- Coverage-only batches consume the same budget. When it is exhausted, preserve the last committed state/input and record `maintenance_budget_exhausted` with backlog counts. Rebuild and check the finalized request: admissible above-target requests follow the one-shot advisory continuation rule; still inadmissible requests end this processing turn with a recoverable error. The session accepts later input/manual compact; never start a repeated known-overflow inference just to make the loop appear to advance.
- If explicit input + system + mandatory tools alone exceed capacity, diagnose `uncompressible_request` before repeated summaries. Do not silently shorten the current prompt or remove mandatory safety tools/instructions.
- Preferred readiness is below `maintenanceTarget`; mandatory dispatch readiness is a finalized complete request within `availableInputCeiling` and not an unchanged provider-rejected fingerprint. Coverage advancement alone never authorizes inference. These conditions govern internal request construction, not the user's ability to submit a prompt. No hard UI gate is introduced.
- Provider-confirmed overflow recovery retains the existing max-one safe retry policy unless a distinct request fingerprint is produced and there were no output/side effects. A duplicate rejected fingerprint is never automatically dispatched again. After effects/unknown execution, preserve recovery evidence and require explicit continuation/checking, not automatic tool replay.

## 5. Minimal durable diagnostics

### 5.1 Schema and ownership

Create `engine/context-compaction-diagnostic.ts` with strict Zod discriminated records (`as const` stages/reasons/outcomes). `store/context-compaction-diagnostic-store.ts` owns SQL helpers and bounded reads; ThreadStore owns database lifecycle/migration and transactions.

Records include only:

- schema/accounting version, diagnostic ID, input ID, maintenance episode ID, local step index, timestamp;
- provider/model identifier, window/source (or unknown), request epoch/fingerprint;
- phase `pre_request/after_tools/provider_overflow/manual`, reason code;
- numeric step usage (input/output/cache/reasoning reported separately; no cumulative-as-window calculation);
- before/after full-request budget component counts, reserves and `estimated`/calibration flags;
- coverage-before/after message/Tool sequences, selected/covered/remaining counts by lane;
- active-byte change, material-space-progress flag, savedTokens (can be negative);
- checkpoint ID/generation if actually committed;
- elapsedMs and numeric compaction-call usage/call count;
- outcome/reason enums `ready/coverage_only/no_progress/budget_exhausted/failed/cancelled/timed_out/interrupted`, safe error class/code, no provider error body.

Tables use `thread_id` FK with `ON DELETE CASCADE`; `(thread_id, diagnostic_id)` makes retries idempotent. Reads accept bounded limits. Retain at most 4096 records and 8 MiB per thread, with oldest-record eviction in its own Store transaction; no effect on transcript/Tool ledgers. No user-configurable retention surface in Phase 1.

### 5.2 Lifecycle and crash consistency

- Write an episode-start diagnostic before a summary request and one measured-step record after each actual request completes. Bind this writer through `ConversationEngine.buildSession` for CLI, scheduler-hosted engine and Runtime service alike, even when `debugEvents=false`.
- The existing checkpoint row ID/generation, written with replacement history under CAS, is the necessary transactional installed marker. Do not add an optional diagnostic-table write to that necessary transaction. Episode/pass linkage may be added as content-free authoritative checkpoint metadata only if required and validated; supplementary `checkpoint_installed` diagnostics are written after the commit with the real returned ID/generation. No network/async callback inside the transaction.
- After installation, finalize the pass diagnostic with the actual rebuilt request's same-basis before/after estimates and final coverage. Retrying this diagnostic write is idempotent and cannot replay inference/Tools or re-commit the checkpoint.
- On SQLite re-open, unfinished starts/installed markers remain distinguishable as interrupted, not falsely succeeded. A `checkpoint_installed` marker can be reconciled to the checkpoint row, but missing budgetAfter must remain missing rather than be fabricated from a later, different request.
- Necessary accepted-input/Tool-ledger/checkpoint persistence failures stop processing. Supplementary diagnostic writes/retention failures report observation degradation but do not become a new availability dependency while necessary state remains reliable. Never claim an unpersisted diagnostic was recorded; never rewind/replay a side effect to repair logging. The minimum installed marker uses existing authoritative checkpoint ID/generation linkage in the necessary transaction; additional diagnostic markers and records are optional observability. Their write/cleanup failure cannot roll back a correctly installed checkpoint. Test both sides of this boundary.
- No-store AgentSession supports the same typed callback with process-local bounded records; it cannot promise SQLite durability.
- Keep public Runtime protocol unchanged in Phase 1: existing `error`, `compaction-start` and `context-compacted` continue to project as today. Add no new RPC/wire event union merely for diagnostics. Store read APIs and acceptance tests can inspect the durable records. Core/Runtime/Protocol typechecks still run to verify compatibility.

## 6. GitNexus impact analysis (performed before code changes)

Bound repository: `roll-agent`; worktree `/Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent`; index/current commit `31816c3`, matching 1347 covered source files at inspection. Explicit `repo=process.cwd()`/`--repo .` was used after `list`. CLI 1.6.12, local backend used only to obtain bounded structured results; full raw tool outputs remain in this conversation.

| Target | Graph risk | Direct callers / affected paths | Design implication |
| --- | --- | --- | --- |
| `AgentSession.runTurn#3` (exact UID) | **CRITICAL**, 9 upstream symbols | `send`; dispatchLegacy, CLI run/runRepl; 7 modules | Acceptance ordering and all failure/cancel/recovery paths need independent review. |
| `runCompaction` | **CRITICAL**, 9 upstream | `recoverFromContextError`, `runAutoCompactionPasses`, `runCompactionTurn`; 5 modules | Change boolean result atomically with every caller; manual/auto recovery regression. |
| `runAutoCompactionPasses` | **CRITICAL**, 7 upstream | `runTurn`; dispatchLegacy, run, runRepl; 6 modules | Removing cap requires episode limits and persistent-input guarantees, not unrestricted loop. |
| `contextPressureTokens` | **CRITICAL**, 9 upstream | `runAutoCompactionPasses`, `runTurn`, `shouldAutoCompact`; 6 modules | New accounting must cover all entry points and not alter legacy Sampling. |
| `estimateMessagesTokens` | **HIGH**, 15 upstream | `prepareStep`, `estimateCompactedTokens`, `compactionTargetTokens`, `contextPressureTokens`, `stopOnContextPressure` | Keep low-level heuristic API for existing callers; add full-request layer instead of global semantic change. |
| `persistMessages` | **CRITICAL**, 16 upstream | `appendInterruptedTurnMessages`, `reconcileUncoveredToolExecutionContext`, `runTurn`; 7 modules | Accepted input offsets and execution coverage must remain atomic and exactly once. |
| `persistCancelledTurn` | **CRITICAL**, 8 upstream | `persistCancelledRecoveryTurn`, `runTurn`; 6 modules | Do not collapse cancellation states or duplicate prompt on early cancellation. |
| `reconcileUncoveredToolExecutionContext` | **CRITICAL**, 10 upstream | `runCompactionTurn`, `runTurn`; 7 modules | Receipt-before-reconcile failure must preserve input and never manufacture Tool outcome. |
| `currentCheckpointReminder` | **CRITICAL**, 16 upstream | `promptOverheadTokens`, `runTurn`; 7 modules | Both before/after snapshots must include exactly the actual returned reminder. |
| `buildSession` | **HIGH**, 5 upstream | `createSession`, `forkSession`, `resumeSession`; dispatchLegacy | Attach receipt/diagnostic persistence to shared Engine, not Ink-only hooks. |
| `stopOnContextPressure` | LOW, 3 upstream | `createStreamResult`; runTurn | Low graph scale does not waive high operational request safety risk. |
| `captureCompactionEvidence` | LOW, 6 upstream | `runCompaction`; evidence flows | Two-lane selection preserves opaque IDs, provenance and contiguous coverage. |
| `buildCompactionSemanticModelContext` | LOW, 6 upstream | `renderCompactionSemanticModelContext`, `captureCompactionEvidence` | Keep bounded evidence cap/actual presented ID list. |
| `renderBoundedModelContext` | LOW, 5 upstream | `buildCompactionSemanticModelContext`, `renderCompactionSemanticEvidenceRegistry` | Fairness must survive size truncation, not only input ordering. |
| `ThreadStore.commitCompaction#2` (exact UID) | LOW, 1 upstream resolved | Engine `commitCompaction` callback | Dynamic callback consumers are undercounted; SQLite/CAS mutation remains high operational risk. |
| `appendMessages` | LOW, 1 upstream resolved | Engine `onPersist` callback | Store API also used in many tests/runtime flows; do not interpret sparse graph as small persistence blast radius. |

Ambiguous names (`runTurn`, `commitCompaction`, `createSession`, `switchModel`) initially yielded UNKNOWN or candidates; exact UIDs were resolved where available. An attempted `runTurn#2` UID did not exist; corrected to indexed `runTurn#3`. Text/source follow-up confirmed callback wiring at `conversation-engine.ts:757-768, 793-833`, cancellations in `agent-session.ts`, and runtime projection at `runtime-service.ts:1673-1686`. The graph does not prove every property/SDK callback edge; gaps are not an all-clear.

Representative execution flows reviewed through query/context/impact: `send → runTurn → runAutoCompactionPasses → runCompaction`; `captureCompactionEvidence → buildCompactionSemanticModelContext`; CLI `run/runRepl` and Runtime `dispatchLegacy` creation/recovery; Engine `createSession/forkSession/resumeSession → buildSession → Store callbacks`.

Final pre-edit recheck is required if HEAD/source/index changes after design approval. Final delivery must run `detect-changes --scope all` on this worktree and inspect structured `partial/truncated`; an output excerpt is not a clean full result. New files must be indexed and staged-equivalent coverage must be explicitly checked without committing or changing the user's index unless authorized. Existing global analyzer budget/dynamic-edge coverage limits must be reported.

## 7. File ownership and proposed changes

| File | Responsibility |
| --- | --- |
| Create `packages/runtime/src/store/turn-input.ts` | Receipt schema/ids and sanitized Skill metadata shape, no duplicate prompt body. |
| Create `packages/runtime/src/engine/model-request.ts` | Shared actual production request composition + canonical fingerprint. |
| Create `packages/runtime/src/engine/request-budget.ts` | Numeric schema-derived budget snapshots, reserves/calibration, finalized-call guard. |
| Create `packages/runtime/src/engine/compaction-recovery.ts` | Pure maintenance episode state/progress/cost transitions and typed host control reason. |
| Create `packages/runtime/src/engine/compaction-evidence-batch.ts` | Bounded, sequence-ordered fair evidence selection. |
| Create `packages/runtime/src/engine/context-compaction-diagnostic.ts` | Content-free diagnostic schema; no Runtime wire contract. |
| Create `packages/runtime/src/store/context-compaction-diagnostic-store.ts` | Diagnostic SQL/retention/read helpers. |
| Modify `packages/runtime/src/store/thread-store.ts` | Receipt/diagnostic tables and APIs; existing checkpoint row is authoritative installation marker, optional diagnostics outside its necessary transaction. |
| Modify `packages/runtime/src/engine/agent-session.ts` | Early input acceptance, one-shot Skill snapshot, shared request usage, safe maintenance/resume and all error offsets. |
| Modify `packages/runtime/src/engine/compactor.ts` | Coverage-only candidate support and observed draft usage/call count; preserve safe fallback classes. |
| Modify `packages/runtime/src/engine/compaction-semantic-state.ts` | Fair actual-presented prompt ordering, preserve validators/provenance. |
| Modify `packages/runtime/src/engine/conversation-engine.ts` | Store receipt/diagnostic hooks and window-source propagation for create/resume/fork/model switch. |
| Modify `packages/runtime/src/index.ts` | Export only required Store/schema public types; do not expose internal control errors as public retry commands. |
| Modify `packages/core/src/cli/chat/ink/state.ts` / tests only if needed | Ensure existing maintenance error/end events restore idle; no input budget disabling or thinking-state change. |
| Tests in corresponding new `*.test.ts`, plus existing Engine/Store/recovery/Runtime service suites | Unit boundaries, real SQLite and SDK mock transport integration. |
| Create `.changeset/context-compaction-reliability.md` | Proposed Runtime minor (new Store APIs/records) + Core patch for host integration; Protocol change only if independent review accepts a contract change, not planned now. |
| Create `docs/reports/2026-10-10-context-compaction-reliability.md` | Commands/results, fixtures vs real subscription distinction, metrics and limits. |

No ownership migration from Runtime to Core; no refactor of unrelated AgentSession tool modules, scheduler state, approval UI or subscription thinking feature.

## 8. Implementation tasks and review checkpoints

All tasks use node:test with isolated `skillLibrary:null` and workspaceInstructions disabled where appropriate. New module/type edits load `typescript-magician`; schema is the source of truth, imports use `.ts`, zero `any`/enum/namespace.

### Task 1 — accepted input and SQLite durability

**Files:** `store/turn-input.ts`, `store/thread-store.ts`, `engine/agent-session.ts`, `engine/conversation-engine.ts`; tests `thread-store.test.ts`, `agent-session.test.ts`, `explicit-skill-context.test.ts`, `explicit-skill-recovery.test.ts`.

**Produces:** `acceptTurnInput`, `recordTurnSkillCheckpoint`, `getTurnInput`, ActiveTurn-local input identity and existing `userMessagePersisted`/segment offsets.

- [x] Write a failing Store test: accepting `inputId=A` twice gives one raw user transcript row and one receipt; accepting identical text with `inputId=B` gives two rows. Close/reopen SQLite and repeat A without reinserting it into active history.
- [x] Write failing session tests for pre-compaction throw/cancel/timeout and failed dynamic/Skill setup. Assert exactly one durable raw user message and no inference call on terminal maintenance failure. New maintenance/Skill fault injection and actual provider failure tests complement the existing dynamic-context cancellation/timeout regression.
- [x] Implement the additive receipt table and acceptance transaction using the same sanitization/append helper as ordinary transcript insertion; roll back all inserts on failure.
- [x] Move acceptance ahead of maintenance, split response persistence offsets, and adapt each cancellation/failure helper. Assert already persisted Tool execution records are not counted or inserted twice.
- [x] Store only sanitized Skill refs in receipt metadata, preserve legacy Skill reading, and use exactly one per-turn loaded snapshot on continuation.
- [x] Run the four named suites and fast file verification (included in passing Runtime full suite); stop for independent review of retention/dedup/cancellation traces before proceeding.

Task 1 implementation note: additive SQLite schema v8, `thread_turn_inputs` has thread-scoped input identity and transcript-sequence FK. Raw history stays append-only; references are sidecar metadata projected transiently for compaction. `onPersist`-only sessions receive a separate early raw-user append and later response/recovery appends; without the new metadata callback, Skill references are process-local, not falsely claimed durable. Fork remaps receipt input IDs and carries only historical refs, never turn execution authority. Existing Tool/CAS and budget controller logic are otherwise unchanged in this batch. See `docs/reports/2026-10-10-context-compaction-reliability-task1.md`.

Suggested test assertions:

```ts
assert.equal(store.listTranscriptMessages(threadId).filter(e => e.message.role === "user").length, 1);
assert.equal(mockInferenceCalls, 0);
assert.equal(store.getTurnInput(threadId, inputId)?.transcriptSequence, firstReceipt.transcriptSequence);
assert.doesNotMatch(JSON.stringify(store.getTurnInput(threadId, inputId)), /SKILL_BODY_SENTINEL/);
```

### Task 1a — temporary tool-parameter streaming status (after Task 1 review)

Task 1 independently accepted by Codex; Task 1a is authorized as a separate batch. Inspect the installed SDK tool-input-start/delta/end events, keep per-call-ID ephemeral state/tool names and throttled UI updates. Implementation decision: no character/token counters; delta bodies do not cross into SessionEvent, UI or persistence. A metadata-only `tool-input-activity` SessionEvent uses the existing ephemeral Engine stream; Runtime wire projector deliberately ignores it, so no public Protocol expansion. Start/end/full-call/error/abort/finish-step update or clear active call membership; repeated delta activity with unchanged membership produces no UI updates. Initial activity and terminal clears are immediate; concurrent membership changes are coalesced at 100ms. Display “正在生成工具参数…” with a sanitized Tool name without character/token counts, never parameter text. Missing observable activity stays “等待模型响应…”. Only a complete tool-call can trigger approval/execution. Parallel/interleaved calls, end/error/cancel/step-finish cleanup, priority versus confirmation/compaction/execution, large chunked file parameters and complete-call-only providers all need tests asserting exactly one approval/execution. Prefer existing SessionEvent temporary channels; report any minimal public Protocol change before making it. No delta bodies in durable logs; no input queue.

Task 1a delivery (Roll verification and independent Codex acceptance):

- [x] Actual SDK metadata-only generation tracker with per-ID cleanup and coalesced updates; no argument-body/counter events.
- [x] Normal Ink waiting/generation distinction, safe names, priority and terminal cleanup.
- [x] Real SDK large-file, interleaved/missing-end calls and no-stream provider fallback: once-only approval/execution.
- [x] Runtime wire replay/transcript sentinel exclusion; Protocol unchanged.
- [x] New 18 tests and complete Runtime/Core/Protocol regressions, types, lint/build/CLI check; Runtime minor/Core patch changeset.
- [x] Codex independent Task 1a acceptance (42 independent tests incl. 18专项; Runtime/Core types/tests/lint/build passed). Full Core E2E and actual subscription inference not performed. Next batch limited to Task 2.

See `docs/reports/2026-10-10-context-compaction-reliability-task1a.md` for results, graph limits and deferred efficiency acceptance.

### Task 2 — request projection, latest-usage calibration and dispatch guard

**Current gate: REQUEST CHANGES after the half-window incident.** The historical successful checks below do not cover the newly reproduced opaque-estimation plus whole-turn recovery-cutoff regression. See `docs/reports/2026-10-12-context-budget-half-window-incident.md`.

2026-10-12 installed-SDK check: precise prompt/tool preparation belongs to SDK (`ai/internal` converters, URL download and dynamic description handling). A public middleware probe confirmed initial/intermediate guard behavior and owned stream-error identity. Proposed minimal revision: use finalized actual SDK parameters for authoritative budget, shared Roll projection for approximate post-step prediction, and finalize `budgetAfter` at the next guarded preparation without extra conversion/download. **Approved in SDK revision section 6; Task 2 corrective delivery now has 23专项 pass and Runtime 1569 pass/17 skip/0 fail. Three reproduced defects and all 30 historic regression failures resolved; independently accepted by Codex on 2026-10-12 (see the independent review report).** See `docs/reports/2026-10-12-context-compaction-task2.md` for final results; the WIP report remains historical evidence. See `docs/plans/2026-10-12-context-request-budget-sdk-checkpoint.md` for evidence and boundaries. This checkpoint is specifically permitted by the Task 2 authorization when SDK constraints require design changes.

**Files:** `engine/model-request.ts`, `engine/request-budget.ts`, `engine/agent-session.ts`, `engine/conversation-engine.ts`; new unit tests plus session tests.

**Consumes:** accepted input identity and protected current-turn snapshot from Task 1.
**Produces:** `buildSessionModelRequest`, `estimateRequestBudget`, `calibrateRequestBudget`, `ContextMaintenanceRequired`, reusable request budgets and window-source propagation.

- [x] Budget/projection fixtures include actual system+Tool schema+Skill+checkpoint/options and initial over-budget guard; captured SDK params counted by the same estimator.
- [x] Latest-step/cumulative/earlier-larger/cached/reasoning/opaque accounting covered; incompatible ordinary residual separated from frozen maintenance basis.
- [x] Production request composition extracted into prepareStep; exact SDK preparation reused (not duplicated) per approved revision.
- [x] Component estimator/reserves and final dispatch guard validated for initial/intermediate SDK wrapping with zero denied Provider dispatch.
- [x] Owned marker bound to actual request; settled canonical/Tool coverage saved before recovery; cancelled episode owner abandonment, overall step/deadline preservation and unknown-overflow net-reduction checks covered.
- [x] New 23专项, full Runtime/Core/Protocol tests, three-package types, lint/build/CLI check passed; original 30 regressions corrected without skips.
- [ ] Independent Codex Task 2 acceptance reopened (2026-10-12 half-window incident): previous original counterexamples resolved; independently re-ran 23专项, full Runtime/Core/Protocol, types, lint/build/CLI and an additional full-request predictor probe. See `docs/reports/2026-10-12-context-compaction-task2-independent-review.md`. Remain at idle; Task 3/4 are separate batches.

Implementation boundary: complete **post-step** predictor uses last actual prepared overhead, compatible latest measured input and shared projected-message delta; no repeated schema/description/download calls. Cold pre-maintenance heuristic and existing 4-pass/2-success behavior remain until Task 3, but cannot bypass final admission. Predictor is approximate, finalized SDK guard is authoritative. `budgetAfter` remains pending until same-owner actual re-preparation, never supplied by another turn. Numeric state is process-local only; durable diagnostics still Task 4.

Suggested assertions:

```ts
assert.equal(budget.estimated, true);
assert.equal(budget.latestMeasuredInput, latestStepUsage.inputTokens);
assert.ok(budget.calibratedInputEstimate > historyOnlyEstimate);
assert.equal(providerCallsForRejectedFingerprint, 0);
assert.deepEqual(capturedAcceptedParams.providerOptions, originalProviderOptions);
```

### Task 3 — fair evidence and bounded maintenance without whole-turn cutoff

**Files:** `engine/compaction-evidence-batch.ts`, `engine/compaction-recovery.ts`, `engine/compactor.ts`, `engine/compaction-semantic-state.ts`, `engine/agent-session.ts`; new helper tests, `compactor.test.ts`, `compaction-semantic-state.test.ts`, `agent-session.test.ts`.

**Consumes:** complete request budget/fingerprint and accepted input from Tasks 1–2.
**Produces:** fair bounded batches, `CompactionPassResult`, coverage-only checkpoints and readiness-gated continuation.

- [x] Add regression tests for >2 successful maintenance episodes in one send, backlog >32 messages plus Tool evidence, unchanged-state retries, and byte-only false progress.
- [x] Implement fair lanes under the same 32-item cap and actual char budget; validated coverage alone advances watermarks.
- [x] Separate committed coverage/history changes from finalized space comparison; preserve Store CAS, Tool pairs and protected input.
- [x] Replace whole-turn continuation exhaustion with episode quantum/cost/deadline/fingerprint logic; reserve actual verification.
- [x] Count actual draft Provider requests and test failure/retry accounting; production retries remain disabled.
- [x] Verify one real write, successful continuation, SQLite reopen with identical ledger identity, and no replay on failure/unknown execution.
- [x] Run full Runtime/Core/Protocol suites, typechecks, lint, relevant builds and isolated release CLI smoke test. See final report for counts and one transient contention rerun.
- [ ] User acceptance of the Codex implementation; do not start Task 4.

Suggested assertions:

```ts
assert.ok(successfulMaintenanceEpisodes >= 3);
assert.ok(selectedMessageEvidence > 0 && selectedToolEvidence > 0);
assert.equal(summaryCallsForRepeatedEquivalentState, 1);
assert.equal(inferenceCallsWhileBudgetUnsafe, 0);
assert.equal(writeSideEffectCount, 1);
assert.ok(coverageAfter.toolExecutionsThroughSequence > coverageBefore.toolExecutionsThroughSequence);
```

### Task 4 — durable diagnostics, integration and delivery

**Files:** diagnostic schema/store helpers, `thread-store.ts`, `conversation-engine.ts`, `compactor.ts`; Engine/Store/Runtime integration tests; changeset and report.

**Consumes:** pass budgets, actual usage, accepted input identity and episode/call results from Tasks 1–3.
**Produces:** minimal durable diagnostic API and a verifiable report without new Runtime wire contracts.

- [ ] Add failing tests proving CLI-style Engine sessions and Runtime service sessions write identical diagnostic schema without `debugEvents`; SQLite close/reopen retains them.
- [ ] Implement start/measured/commit/finalized lifecycle and bounded idempotent reads/retention. Inject cancellation/failure between each transition and assert incomplete records never masquerade as complete budget success.
- [ ] Add credential/text sentinels to messages, tools, Skills, provider errors and configuration; assert they never appear in diagnostic JSON. Test optional writer/retention failure reports observation degradation without replaying effects, stopping reliable requests or rolling back an installed checkpoint.
- [ ] Verify existing protocol projection and user input availability after recoverable errors. Do not add post-turn calls or change thinking behavior.
- [ ] Add Runtime minor/Core patch changeset, run changeset status and full validation below, and save report with real counts and graph limits.
- [ ] Stop at independent Phase 1 acceptance. No commit/push/release. Phase 2 work is not implied by Phase 1 success.

## 9. Verification matrix (required acceptance cases)

| Scenario | Required observable assertion | Test layer |
| --- | --- | --- |
| Long task with >2 successful pressure episodes | Three or more episodes in one send; same input once; continuous guard; same maxSteps/deadline | AgentSession + SDK mock |
| Single very large Tool result | Result persisted; projection reflected in next full budget; paired call/result; compression or recoverable stop before repeat overflow | Session + Store |
| New prompt or explicit Skill crosses budget | Receipt saved before maintenance; actual Skill/reminders counted; no silent clipping; smaller next input still works | Session/Skill + Engine |
| System/tools dominate window | Irreducible component diagnosis, no endless summaries; Tool schema policy unchanged | Budget + integration |
| Same state no progress | Same fingerprint not summarized indefinitely; one fallback maximum; unsafe state gives recoverable error, next send possible | Controller + Session |
| Immutable input above 75% but within reserved capacity | Advisory target miss is recorded; safely admissible prompt is processed once without a repeated summary loop or UI rejection | Budget + Session |
| Agent refresh / Tool policy changes mid-turn | Effective schemas and request epoch rebuild at a settled boundary; new overhead counted, old effect not repeated | Request + Session |
| Coverage advances but budget does not yet fall | Bounded intermediate checkpoints allowed; correct watermarks; no inference until full budget readiness | Semantic + Store + Session |
| Checkpoint enlarges total request | Negative saving recorded; active bytes alone do not admit inference | Budget + Session |
| One-byte progress chain | Does not renew maintenance deadline/call ceiling; bounded actual provider request count | Controller |
| More than 32 backlog / four-pass quantum | Both continuity lanes get service; no skipped coverage; quantum yield doesn't reset budget or unlock model calls | Fairness + Session |
| Pre-compaction provider failure/cancel/timeout | Raw input+receipt exactly once, partial progress durable, no success claim | Store + Session |
| Cancellation during Skill/dynamic context/commit | Original input retained; metadata sanitized; transaction rollback or committed state only | Engine/Store fault injection |
| Resume after completed write / unknown execution | No write replay; outcome stays success/unknown as originally recorded; input not appended twice | SQLite reopen + recovery |
| Single uncompressible huge input | Current turn explicit recoverable error; user input not disabled; later smaller goal accepted | Session + Ink smoke |
| Provider-confirmed overflow | One bounded safe recovery with changed fingerprint; identical rejected request not automatically resent | Provider mock |
| Unknown window / compaction disabled | No fake window or re-enabled policy; preserved input and explicit provider errors | Budget + regression |
| SQLite old schema upgrade/reopen/fork/delete | Additive tables work, FK cascade, receipts/diagnostics isolate threads, no forged copied turn dispatch | Store/Engine |
| Diagnostic persistence disabled/debug=false | Stored Engine still writes diagnostics; no-store mode accurately process-local | Engine + Runtime service |
| Diagnostic write/retention failure/crash gap | Report degraded observability, do not roll back a correct checkpoint or block reliable processing; no Tool replay; interrupted records distinguishable | Store fault injection |
| Calibration residual resets without payload shrink | Raw estimate unchanged/larger; frozen-calibration comparison shows no space improvement or false restored admission | Budget + Controller |
| Original API/ChatGPT/Sampling | Legacy API thinking mapping, subscription xhigh/max serialization and standalone Sampling isolation unchanged | Core regression |
| Runtime/CLI protocol | Existing event projection accepts messages/errors; input survives maintenance; no new wire union/version | Protocol/Service/Core |
| Final stop completion | No new post-response maintenance provider call in Phase 1; next input triggers protected maintenance | Session |

### Later compression-efficiency acceptance (record only in Task 1a)

Independent read-only observation: one specified session had gen10–13 semantic message coverage 319/351/383/415 with Tool coverage -1, versus captured messages 440/Tools 696. Captured range is not semantic coverage; disk JSON bytes are not sent tokens. Removing the pass cap alone may only prolong catch-up. Task 2/3 and Phase 2 must compare the same task's total summary calls, same-calibration complete-request net release, useful Tool steps before the next maintenance and information retention. Separate evidence backlog catch-up from freeing the window. Phase 1 retains 75% triggering and prevents invalid repeats; Phase 2 chooses batch throughput and a below-trigger recovery headroom target from data, not an unmeasured fixed 50%/60%.

## 10. Validation commands and delivery evidence

Run from the worktree with explicit tool `workdir`; do not use shell `cd`. Long commands use background exec/poll. No installation or network inference is part of these checks.

```bash
pnpm --filter @roll-agent/runtime typecheck
pnpm --filter @roll-agent/core typecheck
pnpm --filter @roll-agent/protocol typecheck
pnpm --filter @roll-agent/runtime test
pnpm --filter @roll-agent/core test
pnpm --filter @roll-agent/protocol test
pnpm lint
pnpm --filter @roll-agent/core test:e2e
pnpm --filter @roll-agent/runtime build
pnpm --filter @roll-agent/core build
node packages/core/dist/cli/index.js agent health
pnpm exec changeset status
```

Also: fast verification on every changed code file; targeted Prettier checks; `git diff --check`; fresh per-symbol impact before edits if baseline changes; final refreshed GitNexus `detect-changes --scope all` and its complete structured degradation flags. Runtime build/published CLI smoke checks only prove local artifacts, not successful release. If Protocol remains unchanged, run its checks for contract compatibility rather than claiming a Protocol feature addition.

Use actual SQLite temporary databases and real local SDK/mock-provider request dispatch for integration tests. Fixtures are not real subscription inference. Real subscription validation, if later authorized, must be separately identified with actual usage and outcomes; do not infer latency/reliability from fake transport.

Delivery report must include before/after same-basis budget totals, selected/covered message+Tool counts per pass, actual summary requests/usage/time, episode outcomes, preserved-input counts, write replay counters, SQL re-open results, commands/exit codes, graph coverage limits and remaining gaps. No assertion that Phase 1 proves the retrospective first-task root cause.

## 11. Risks and design-checkpoint decisions

1. **CRITICAL — early input persistence changes failure offsets.** A flag alone cannot handle stream truncation/resume; receipt transaction and every interruption path must be reviewed together.
2. **CRITICAL — SDK control-flow errors can look like provider errors.** Last-chance pause must be identified by owned marker, settled before history changes, tested through the real installed SDK. No replay route may bypass Tool ledger evidence.
3. **HIGH — full budget is still an estimate.** Multimodal/opaque provider representations and hidden overhead require labeled calibration/reserves; no universal reasoning-output token assumption or promise that the server will always accept the estimate.
4. **HIGH — coverage-only checkpoints may increase budget.** They are intermediate commits under fixed cost limits, not successful space recovery; actual returned checkpoint reminder must be included before continuation.
5. **HIGH — bounded evidence is slower than a single freeform summary.** Fair lanes solve starvation but not all throughput problems. Four-pass quanta plus backlog-derived call ceilings/deadline give bounded recoverable behavior; Phase 2 tunes with measurements.
6. **HIGH — diagnostic/receipt persistence expands SQLite surface.** Additive schema, idempotent writes, FK isolation, CAS and rollback tests are mandatory. No public protocol expansion is planned; Store writes failing after effects never authorize replay.
7. **Behavior boundary — user can always submit the next prompt when idle, not an assurance that every oversized input can infer successfully.** Explicit recoverable errors retain the original input and prior outcomes, and do not permanently disable the session.
8. **Known limits remain:** retrospective first-task causality is unresolved; 16k generic/8k production semantic reminder budgets are existing facts, not proven cause; no post-response maintenance or compact semantic-memory redesign in Phase 1.

Design review outcome: overall direction accepted. Reserve policy (5%/8192/2%) and 120s budget remain testable heuristics, not server-acceptance guarantees. The 75% target remains soft. Task 1 acceptance includes early failure/cancel/timeout, stable-ID idempotency, repeated explicit text, SQLite reopen/old schema, resume/fork, direct AgentSession and legacy onPersist. Tasks 2–4 await later batch review. Diagnostic failure behavior is observation degradation, distinct from necessary-state failure.

## 12. Design author self-check

- [x] Baseline, worktree, toolchain and GitNexus freshness verified; no code changes during design.
- [x] Input retention, long-turn protection, complete budget, split progress, starvation and durable diagnostics each have an owner/task/test.
- [x] Existing reminder/active-byte protections and uncertain historic diagnosis explicitly acknowledged.
- [x] All source/proposed paths are distinguished; TypeScript interfaces/constants have a single declared owner.
- [x] Phase 2, threshold changes, post-response maintenance, committed thinking feature and automatic commits/push/releases excluded.
- [x] Required validation matrix covers the independent-review additions.
- [x] Codex independent design review passed with calibration/observability/input-retention amendments.
- [x] Implementation started after review; only Task 1 is authorized for this batch.
- [ ] Independent Phase 1 acceptance and verifiable delivery report.
