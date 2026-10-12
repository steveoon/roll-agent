# Task 2 — Installed SDK Request Preparation Revision Checkpoint

**Status:** Minimal engineering revision independently approved by Codex on 2026-10-12, with the requirements in section 6. Task 2 implementation may continue under the existing authorization and must stop for independent implementation acceptance. Task 3/4 remain gated. No Task 2 production implementation has been accepted yet.

**Baseline/worktree:** `31816c3`, `dev`, `/Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent`. Task 1/1a accepted changes remain uncommitted. No staging, commit, push, release, host restart, model/thinking/approval setting change, or execution-time input queue. Date of this checkpoint: 2026-10-12.

## 1. What requires clarification

The reviewed plan asks for shared production request construction/schema preparation, complete pre-request/post-maintenance budgeting, and a final guard on provider-neutral `doStream` parameters. The final guard is implementable with the public `wrapLanguageModel` API. The precise pre-guard SDK conversion is not a public `ai` root preparation API:

- `ai/src/prompt/prepare-tools.ts` resolves callable descriptions with toolsContext/sandbox, input examples, provider options, strict mode, provider tools and the actual `asSchema(...).jsonSchema`.
- `ai/src/prompt/convert-to-language-model-prompt.ts` normalizes roles/content, combines Tool messages, carries provider metadata and downloads unsupported URL assets.
- SDK `stream-text.ts:1955-2003` filters effective tools/callers, prepares schemas and resolves step overrides before dispatch.
- These exact converters are exported by **`ai/internal`**, not by the stable root API. They exist; this checkpoint does not incorrectly claim they are unavailable. Importing `ai/internal` in production is an explicit internal-SDK coupling and requires review rather than silently introducing it.
- A separate public `asSchema` call is not equivalent to the SDK's full tool preparation. A second full prompt conversion can download the same URL twice; the SDK itself documents converting only once per step (`stream-language-model-call.ts:261-264`). Description/schema caching also cannot assume a dynamic definition is stable for the entire session.

Therefore, copying these converters, prebuilding an independent schema approximation and treating it as exact, or adding a shadow SDK preparation pass would violate the intended no-drift/no-extra-side-effect rule.

## 2. Recommended minimal revision: finalized preparation is authoritative

Keep the shared Roll-level production projection in `engine/model-request.ts`, but let the **single actual inference SDK preparation** produce the authoritative request definition.

1. `buildSessionModelRequest` assembles the exact Roll model messages, system, effective ToolSet and provider options used by `streamText`/`prepareStep`: current accepted input, current-turn Skill snapshot once, capability/checkpoint reminder, cancellation materialization, stripped historical metadata, canonical observations and Tool-image relocation. It is not a replacement SDK converter.
2. Do not independently resolve/serialize function/provider Tool definitions for authoritative accounting. The inference-only `wrapLanguageModel.wrapStream` receives actual prepared `LanguageModelV4CallOptions` and counts its finalized `prompt`, `tools`, relevant provider-neutral options and explicit output cap with one component estimator. The underlying Provider receives the same parameters unchanged only when admitted.
3. Any cheap budget used at post-step stop conditions is explicitly a prediction, never a final safety verdict. The post-step predictor can use the shared Roll projection and the most recently captured prepared Tool/system components; dynamic-schema/shape mismatch forces finalized rechecking. There is **no second call to description/schema resolvers or image download** solely for budgeting.
4. When finalized parameters cross the soft target (75%), pause once for that state if compaction is enabled and the existing Task 2 minimal-recovery budget allows it. Above-target requests within reserved capacity can proceed after bounded maintenance with a memoized advisory miss; 75% does not become a hard prompt-validity limit.
5. When finalized parameters exceed reserved capacity or match a Provider-confirmed rejected fingerprint, do not call the underlying Provider. Set an owned stream-local control marker carrying the budget/fingerprint and an ActiveTurn token; throw that marker into SDK's existing stream error path.
6. The outer driver recognizes only the marker owned by this stream/ActiveTurn, never a model/Tool error string. After settling the stream, persist remembered completed canonical steps and Tool coverage before maintenance. Initial pauses have zero completed steps; intermediate pauses do not replay those steps. The failed pre-dispatch attempt does not consume a completed-step count.
7. After a checkpoint is installed, rebuild Roll projection and let the **next actual SDK preparation** reach the guard, still with zero Provider dispatch unless admissible. That guard provides the same-basis `budgetAfter`; do not claim an exact full-request estimate immediately at checkpoint commit when the final SDK conversion has not happened yet.
8. A snapshot awaiting finalized `budgetAfter` is explicitly pending. Retain `budgetBefore`, a frozen calibration residual and raw estimate for the episode; clearing measurement correspondence cannot manufacture a reduction. Compare before/after with the same estimator/calibration version. Same/larger payload + residual reset is not progress or sufficient to restore admission.
9. Latest measured input updates only against its matching dispatched request on successful model-call completion. Cached input remains occupancy, cumulative usage remains billing, reasoning/output usage is not blindly replayable input. Capture only actual next-request content; non-text/opaque estimates and reserves remain labeled heuristic.
10. Existing overall deadline, cancellation, maxSteps, SDK approval and Tool coordinator/ledger remain authoritative. Minimized Task 2 recovery remains bounded; existing evidence fairness/four-pass/whole-turn cap changes stay in Task 3. A guard marker must never be left unhandled, even if the existing cap is exhausted: preserve input/evidence and emit a recoverable error instead of calling an unsafe request.
11. Tool/schema/workspace policy changes at a settled boundary require a fresh stream using the current production ToolSet. Do not mutate an old SDK execution-tool snapshot in place. A dynamic description already resolved by SDK is counted as actually resolved, not re-run for analysis.
12. Unknown window remains unknown; compaction disabled remains disabled. Neither condition invents capacity or silently reenables maintenance. Provider-confirmed overflow fingerprints still cannot be automatically redispatched unchanged. Current user input is never disabled or silently clipped.

This revises **the timing and source of exact budgeting**, not any approved reserves, threshold, evidence authority, protocol or scope. The final guard is the single authoritative check; the pre-step predictor is labeled non-authoritative.

### Alternative not recommended without explicit approval

Use `ai/internal` converters as an adapter and supply the prepared prompt to the actual Provider without a second conversion. This would require deeper SDK integration or compiled SDK coupling than the approved narrow wrapper. Simply running internal conversion once for estimates and again for the actual request is not acceptable. No deep-import workaround or dependence on pnpm filesystem layout will be implemented.

## 3. Installed-SDK probe (actual local tool execution)

Environment: Node 24.21.0, pnpm 11.24.0, `ai@7.0.65`, `MockLanguageModelV4`, public `streamText`, `wrapLanguageModel`, `tool`, `jsonSchema`. Script executed in-memory through shell; no repository test/production file added and no remote model called. A mock Tool increments a process-local counter, not an external write.

| Guard scenario | Prepared attempts | Underlying Provider calls | Tool counter | Remembered completed steps | `result.steps` |
| --- | --- | --- | --- | --- | --- |
| Block initial request | 1 | **0** | **0** | 0 | Rejects with generic “No output generated. Check the stream for errors.”, not the owned marker |
| Allow first Tool step, block second request | 2 | **1** | **1** | **1** | Resolves with one completed step |

Both actual `fullStream` executions emitted an error part carrying the identical owned marker. This is evidence for using the stream-local marker, not assuming the final Promise preserves marker identity. Actual prepared parameters contained system/user messages, resolved description/inputSchema and, for the second request, the Tool result. The callable Tool description ran twice per SDK request in this fixture; no host budgeting call invoked it separately. Do not generalize that count to every Provider; it demonstrates why duplicate preparation/caching needs care.

These are **SDK boundary probes only**, not Task 2 implementation tests, not real subscription calls, not proof of database durability or production latency. Planned tests after review still need real temporary-workspace write Tools, SQLite persistence, schema/dynamic-context changes, cancellation/timeouts, frozen calibration and no replay under initial/intermediate guard.

## 4. GitNexus impact and evidence limits

Repository explicitly bound via `list`: `roll-agent`, worktree above, index/HEAD `31816c3`. No source code changed in this continuation.

Current upstream queries return CRITICAL for `stopOnContextPressure`, `contextPressureTokens`, `modelTools`, `promptOverheadTokens`, `recoverFromContextError`, `buildSession`; `runTurn` lookup is ambiguous/UNKNOWN. Some result names/file edges are clearly inconsistent with source (unrelated browser/electron classes reported as immediate callers). These are graph-quality gaps, not evidence of low risk or actual browser behavior changes. Source inspection confirms:

- `AgentSession.runTurn:1648-1743` constructs stream/prepareStep and binds approval/coordinator.
- `runTurn:2057-2285` handles errors, settles messages, persists Tool coverage and restarts pressure-paused streams.
- `stopOnContextPressure:2800-2837` runs after SDK client outputs; `contextPressureTokens:2840-2849` currently omits complete cold request overhead.
- `ConversationEngine.buildSession` supplies model/window/storage callbacks to CLI and Runtime consumers; model switching remains idle-only.

Do not report this graph traversal as a clean precise caller set. Before production edits, refresh/recheck exact impacted methods and file-level dependencies; if graph inconsistencies persist, record them and cross-check real callback source/tests. Full mutation risk remains CRITICAL. The independent reviewer must examine guard→stream error→completed-step persistence→maintenance→new stream, not merely an estimator unit test.

## 5. Current checks and review request

- Runtime, Core/UI and Protocol baseline typechecks passed on the final resumed state.
- Task 1 report heading changed to independently accepted; Task 1a report now attributes the coordinator's 42 independent tests and build results. It still explicitly excludes real subscription and complete Core E2E validation.
- Plan's contradictory optional-character-count wording removed; no parameter character/token counters are promised.
- Production code, Tool approval, model/thinking/configuration and public Protocol have no **new Task 2** edits. Earlier accepted Task 1/1a worktree diffs remain intact.

**Review requested:** accept the finalized-SDK-only authoritative budget source and delayed finalized post-maintenance measurement, with the shared logical post-step predictor labeled approximate. On approval, implement Task 2 with its minimal handled recovery and tests; stop again for independent acceptance. Do not start Task 3/4.

## 6. Independent Codex decision — approved for Task 2 implementation

Codex independently inspected the installed SDK preparation, middleware, continuation/error and retry paths and reproduced both boundary cases with its own controlled-provider script (`/tmp/codex-roll-task2-sdk-review.mjs`). No remote model or external side effect was used. Results:

| Blocked request | Prepared attempts | Actual Provider calls | Local tool counter | Remembered completed steps | Owned marker in stream |
| --- | --- | --- | --- | --- | --- |
| Initial | 1 | 0 | 0 | 0 | Yes; `steps` rejects with a different generic error |
| After a tool step | 2 | 1 | 1 | 1 | Yes; `steps` resolves with the completed step |

The revision is approved. Production SDK preparation is the authority for request structure; token counts remain estimates, even for finalized parameters. Cheap logical predictions are not dispatch admission or measured usage. No duplicate prompt conversion/schema/description resolution solely for budgeting is required or approved.

Implementation and tests must additionally satisfy:

1. Freeze the comparison residual/accounting basis through the episode's finalized post-maintenance guard. Do not install a new measurement or discard the old residual before that comparison. If cancellation/failure occurs before re-preparation, `budgetAfter` remains absent/pending; no logical estimate may masquerade as the finalized after budget.
2. Bound preparation/recovery attempts as well as summary calls. A refused dispatch can still have incurred SDK asset preparation and callback work. Repeated equivalent unsafe requests must terminate recoverably without network dispatch; repeated unchanged soft-target requests must not trigger endless maintenance. Every attempt remains under the same turn deadline, cancellation and step budget. Do not change Task 3's controller policy in this batch.
3. Bind successful input usage to the exact dispatched prepared request. Dynamic resolved descriptions, schemas, system/Skill/checkpoint and provider options participate in shape/fingerprint invalidation. Unchanged registry identity alone is insufficient to reuse finalized schema overhead or measurement correspondence.
4. SDK invokes `onLanguageModelCallStart` before the guard; the independent probe observed start without end for blocked requests. Verify coordinator cleanup or replacement at this boundary, plus final turn cleanup and a later usable turn. A refused dispatch is neither a completed model step nor a started tool effect; do not fabricate a matching successful call-end event.
5. Preserve remembered canonical completed steps and Tool coverage through error parts and rejected result promises before maintenance. Test an actual temporary-workspace write, unchanged ledger identity, initial/intermediate guards, timeout/cancellation and subsequent continuation without replay. Genuine provider errors remain distinct from the owned stream-local marker.
6. Document prepared structure versus heuristic tokens, latest input occupancy versus cumulative billing, and actual provider calls versus prepared attempts separately. Opaque/multimodal/provider-specific overhead remains explicitly estimated. Standalone Sampling and compaction use the underlying model; do not recursively guard compaction.

The independent review report is `docs/reports/2026-10-12-context-compaction-task2-design-review.md`. This written decision is available to Roll, but no UI prompt has been sent: Metalterm computer-use access currently returns an approval denial. No execution-time input, cancellation, restart, commit, push, release or automation resumption was performed. Task 2 must finish and stop at its next implementation review checkpoint; this approval does not authorize automatic Task 3/4 execution.
