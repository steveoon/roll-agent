# Context Compaction Reliability — Task 1a Delivery Checkpoint

## Scope and status

- Task 1 independently accepted by Codex, limited to input reception/persistence; independent results are now attributed in the Task 1 report.
- Task 1a implemented: normal Ink chat distinguishes actual Tool argument generation from waiting for model response, using the installed SDK stream events. **Independently accepted by Codex for Task 1a only.**
- HEAD still `31816c3`; Task 1 + Task 1a changes remain in the worktree. No staging, commit, push, publish, host replacement/restart or changes to user model/thinking/approval settings.
- Task 2–4 are not started. No queue for execution-time prompt insertion, no threshold/controller/summary change or post-response maintenance calls.
- `packages/protocol` has no diff; Runtime Protocol version and wire event union unchanged. The additive Engine `SessionEvent` is covered by a Runtime minor changeset, not silently introduced as a wire contract.

## Actual SDK contract checked

AI SDK 7.0.65 `packages/runtime/node_modules/ai/src/generate-text/stream-text-result.ts:474-495`:

- `tool-input-start`: `id`, `toolName` (plus optional provider metadata).
- `tool-input-delta`: `id`, `delta`.
- `tool-input-end`: `id`.

The fullStream forwards these parts before completed tool-call parsing/execution. The patch observes those parts only; it neither parses accumulated JSON nor invokes approval/execution from them. Complete Tool calls keep the existing coordinator/policy/ledger path unchanged.

## Implementation

### Runtime ephemeral activity

New `engine/tool-input-activity.ts` has one process-local tracker per inference stream:

- Stores only `Map<callId, { toolCallId, name? }>`; never receives/retains delta text, argument JSON, token or character counters.
- Tool names are looked up in the actual session Tool registry. Only ASCII identifier-format registered names up to 160 characters are exposed. Unknown or unsafe names produce a generic label; model-supplied names/control characters are not echoed into terminal status.
- First active call is published immediately; additional concurrent starts coalesce over a 100ms timer. Repeated deltas on unchanged call membership produce **zero UI events**. End/complete/terminal clears are immediate so stale names cannot be resurrected by an outstanding timer; this is not a promise to rate-limit terminal control events to 10 Hz.
- A duplicate start cannot overwrite an active call's identity/name. Orphan delta/end does not invent a call. At most 128 simultaneous call metadata entries are observed; extra calls are not monitored by this display helper, but Tool execution policy is unaffected.
- End/full tool-call/tool-error removes only its own call ID. Finish-step, error, abort, abort signal and stream finally clear/dispose the map and timer, including missing-end cases and context-pressure stream boundaries.
- `agent-session.ts` adds no new Tool execution record, pendingToolCall, side-effect flag or approval when observing parameter generation. Those stay triggered by completed Tool calls only.
- Metadata snapshots use the existing ephemeral `AsyncEventQueue<SessionEvent>` as `tool-input-activity`. They are not `debug` events, so normal Ink needs no verbose mode. No parameter deltas enter this event channel.
- Runtime service explicitly ignores this event in public projection. The wire replay/log and transcript sentinel test proves no `tool-input-activity` or temporary call ID is archived. The existing completed Tool-call input/result audit contract remains unchanged; this patch does not remove full accepted arguments from legitimate Tool records or approval previews.

### Core Ink presentation

`LiveState.generatingTools` derives its type from the single Engine `SessionEvent` variant. Existing static LiveState fixtures, including schedule-browser empty state, add an empty array only.

Activity priority:

```text
idle (no status)
→ cancellation
→ confirmation / user-input prompt
→ compaction
→ active Tool execution
→ Tool argument generation
→ reasoning / reply
→ waiting for model response
```

Generation label:

```text
正在生成工具参数 roll.write_file…
正在生成工具参数 roll.write_file 等 2 项…
正在生成工具参数…          # no safe registered name
```

No parameters, received-text counters or token guesses appear. Call IDs are internal keys only, not displayed. Normal providers without observable tool-input-start stay honestly at waiting/reasoning/reply until an actual full call appears. `tool-input-end` means generation ended, not Tool executed; between end and execution the UI may correctly return to waiting.

Reducer clears generation on completed matching call, message-start, step-finish, compaction-start, confirmation, message-finish, error, turn-cancelled, cancel-requested and turn-end. Late metadata in idle/cancelling is ignored. Existing Tool rows, approval choice UI, input availability and execution display behavior are preserved.

Basic REPL retains its existing rendering; the visible feature is normal/default Ink. Direct Engine consumers may observe the additive body-free metadata event; Runtime wire clients do not receive it in this phase. No use-session argument buffering or new public Protocol compatibility branch was needed.

## Verification

All final checks run locally in the worktree (Node 24.21.0 / pnpm 11.24.0). New tests use the real installed SDK and temporary local files/Ink, with a controlled mock Provider. They are **not real API/subscription inference**.

| Check | Final result |
| --- | --- |
| Task 1a new suites (tracker, stream, interleaved, UI reducer/activity, normal Ink/real SDK) | **18 tests, 18 pass, 0 fail** |
| Runtime full test | **1563 tests, 1546 pass, 0 fail, 17 platform skips** |
| Core full test | **1938 tests, 1933 pass, 0 fail, 5 skips** |
| Protocol full test | **48 pass, 0 fail** |
| Runtime/Core+UI/Protocol typecheck | Passed |
| `pnpm lint` + all changed Task 1a code fast verification | Passed after fixes |
| Runtime build | Passed; 120 JS files |
| Core/UI build | Passed; 292 JS files, React UI built |
| `node packages/core/dist/cli/index.js agent health` | Passed, status/readiness only |
| `pnpm exec changeset status` | Valid; new Task 1a Runtime minor/Core patch coexists with prior changesets |
| Prettier check / `git diff --check` | Passed |

New-test evidence:

1. Large file content split into roughly 840 partial JSON deltas: no file, no execution ledger entry, no approval during generation; after complete call one approval, one Tool-call/result, one successful write with exact file content. Same assertions for missing tool-input-end and complete-call-only provider.
2. Two interleaved IDs, out-of-order end and one missing end: both visible in metadata after coalescing; no effects before complete; each complete call has one approval and one execution. Both temporary files match expected content.
3. Missing complete calls cleared by end, step boundary, provider error or cancellation: no Tool-call/result/approval or ledger execution fabricated; a subsequent turn has no stale metadata.
4. 1000 interleaved deltas cause no per-delta UI events; duplicate starts, orphan IDs, unsafe names and cancelled timers covered.
5. Real AgentSession/SDK rendered in normal Ink (debug off): waiting → parameter generation with safe name → waiting after end → idle. Parameter sentinel never appears in frames; no Tool execution from incomplete JSON.
6. UI activity prioritizes Tool execution, compaction, confirmation and cancellation; all terminal reducer paths clear generation and create no Tool success history.
7. Runtime service fixture emits temporary generation sentinels around ordinary approval. Persisted Runtime replay and raw transcript omit them; existing approval scope/resolution semantics still pass the full suite.

Intermediate errors and recovery, not hidden:

- New tracker test initially failed because the implementation module was absent (red-before-green).
- Adding LiveState required empty metadata arrays in schedule-browser and three LiveRegion fixtures; fixed without changing their functionality.
- Initial diagnostic-isolation test mistakenly called nonexistent `listRuntimeEvents`; corrected to the actual Store `resumeRuntimeEvents`, then full Runtime suite passed.
- New helper/test conditional-style lint failures were fixed. After all full behavioral suites passed, the final change was two conditional braces in the stream test; that suite was re-run successfully and final whole-repo lint/build passed. No behavior change after those full test results.

Full Core E2E and real subscription calls were **not run** for this checkpoint; no browser/live account/model configuration was changed. Phase 1 final verification still includes planned E2E.

## GitNexus risk/coverage

Bound worktree/repository: `roll-agent`, `/Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent`, baseline `31816c3`.

- Before edits: `applySessionEvent` LOW (chatReducer caller), `resolveTurnActivity` LOW (ChatSessionView caller), `LiveState` HIGH (30 upstream UI consumers), nested `drive` HIGH. Shared stream/SessionEvent paths were treated as high operational risk.
- `runTurn` exact UID from the previous index no longer resolved; name lookup was ambiguous. File-level impact and direct source inspection confirmed AgentSession/Engine/CLI callers. `SessionEvent`, `TurnStatusLine`, `ACTIVITY_COLORS` also had unresolved reference edges; imports/renderer use and typechecks were inspected, not interpreted as unused.
- Refreshed index successfully: 40,218 nodes, 132,459 edges, 1111 clusters, 1047 flows. New helper/tests included without modifying the staging index.
- Structured `detect_changes(scope=all)` for cumulative **tracked Task 1+1a** changes: 16 files, 31 symbols, 1038 affected flows, **CRITICAL**, `partial=false`, `truncated=false`. Untracked new files are excluded from git diff and checked separately.
- Refreshed individual upstream traversals: tracker CRITICAL/1011, activity resolver and reducer CRITICAL/928, Runtime projector CRITICAL/4. These broad traversals include shared/dynamic names; they are not waived as irrelevant and do not prove 1038 actual runtime behaviors changed. Independent review must prioritize real stream→metadata→UI and Engine→Runtime projection flows, plus full regressions.
- Analyzer warns of callable-value-flow candidate caps, unresolved cross-language fields and ranked process/depth/branch/walk omissions. A non-degraded detect result is not an all-risk proof. Type-import/delta-return/test-brace formatting edits during/after analysis may be newer than the indexed source hash; no production call topology changed after the analyzed patch. Complete pre-commit freshness is not claimed; no commit is made.
- Full structured result retained in tool dump `/Users/rensiwen/.roll-agent/bash-output-dumps/1791628792329-bash-ac038c53-2a8f-467b-bcce-eed86753b2a7.log` for reviewer access, not a repository portable artifact.

## Coordination and deferred work

- Task 1 independent acceptance results were added to its report with attribution; no claim of independently executing Codex's commands.
- Later compression-efficiency requirements recorded in the plan only: compare summary call totals, same-calibration complete-request net release, useful subsequent Tool steps and information retention. Distinguish captured ranges/semantic coverage/disk bytes/sent tokens and backlog catch-up/window release. Do not blindly set a 50%/60% recovery target.
- No changes to 32-evidence batching, four-pass controller, calibration, diagnostics storage, thresholds or summary memory density in this batch.
## Independent Codex acceptance (coordinator-reported)

Codex independently reviewed production diff, tracker, SDK/Ink integration tests, Runtime projection and report. Reported results: 42 independent tests passed (including all 18专项), Runtime 1546 pass/17 skip, Core 1933 pass/5 skip, three-package typecheck, repaired repo lint, diff check, Runtime/Core+UI builds and published `agent health` passed. No actual subscription inference or full Core E2E. These results are attributed to the independent reviewer, not represented as Roll's own tool executions. Acceptance is limited to Task 1a; Phase 1 is not complete. Task 2 is authorized next as a separate reviewed batch; Task 3/4 remain gated.
