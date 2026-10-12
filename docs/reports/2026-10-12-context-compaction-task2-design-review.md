# Task 2 — Codex independent design pre-review

Date: 2026-10-12 (Asia/Singapore). Repository: nano-agent, dev@31816c3.

## Status and scope

The existing Task 2 design is suitable for implementation, subject to the acceptance requirements below. This is a design pre-review, not implementation acceptance. Task 1 and Task 1a were independently accepted previously. Their documentation has now been updated by Roll. No Task 2 request-budget/model-request modules, tests or delivery report were present at this review.

The authorized Roll session is `6ae73b8d-e223-4187-97be-4eadd7315850`. Its latest user instruction is the 2026-10-12 continuation request. Only that session was read, through a read-only SQLite connection. Metalterm computer-use access was denied; no UI input, prompt insertion, cancellation or restart was attempted. Both Codex automations remain paused. No commit, push, release or changes to production source were performed by this review.

## Evidence and design decisions

- The current production request composition is in `AgentSession.runTurn`, with projected canonical step messages, explicit Skill context, reminders, tool-image relocation and `modelTools()`. The estimator must consume that production composition rather than reconstruct it independently.
- The installed SDK's `stream-text.ts` prepares step messages/instructions/tools before `streamLanguageModelCall`; its continuation decision runs after client tool results settle. Nested continuation exceptions become stream error parts. A synchronous try/catch around `streamText()` is insufficient for the dispatch guard.
- `wrap-language-model.ts` exposes the finalized `LanguageModelV4CallOptions` before delegation. A guard there can refuse the actual inference dispatch while preserving options. Keep this wrapper local to the inference call; the underlying model also serves compaction and must remain usable for maintenance.
- The SDK retry predicate in `retry-with-exponential-backoff.ts` retries retryable API/Gateway errors. Use an owned internal maintenance signal rather than impersonating a retryable API failure or matching an error-message string.
- `stream-language-model-call.ts` invokes the language-model-call start callback before `doStream`. Inspect batch-coordinator state when the guard rejects after this callback; a refused dispatch must not leave a phantom batch, completed step or execution authority.
- Current `AgentSession` still retains the largest successful input usage in a stream, the two-pressure-continuation limit and four-pass compaction loop. These are the baseline, not evidence of the proposed changes being implemented. The whole-turn continuation policy and fair evidence batching belong to Task 3.

## Required independent acceptance

1. Capture actual installed-SDK mock-provider call parameters. Count system/instructions, effective filtered tool schemas, current input, Skill/checkpoint/reminders and completed tool results exactly once. Verify logical projection and finalized dispatch counts, with explicit estimates for opaque/multimodal parts and provider-specific serialization overhead.
2. Calibrate against the latest successful request and its matching estimate. Separate occupancy, cached input, output/reasoning and cumulative billing. Test an earlier large request followed by a smaller request. A changed epoch/model or calibration reset must not manufacture net space release; maintenance comparisons use a common basis.
3. Test the initial guard and a guard after an executed write tool through the installed SDK. Unsafe requests never reach the underlying provider. Retrieve remembered completed steps, persist canonical responses and tool ledger coverage before maintenance. Preserve exactly one write effect and original execution identity, including missing/unknown outcomes.
4. Recognize only the owned request-bound pause signal through error parts and rejected SDK result promises. Complete stream/batch cleanup. Do not increment completed-step counters for refused dispatch, reset the turn timer, bypass rejection/approval policies or retry genuine provider errors after effects.
5. Keep 75% as a soft maintenance target. A complete request within reserved capacity may proceed after bounded maintenance, with memoized handling of unchanged above-target states. Unknown windows and explicitly disabled compaction must remain honest; never redispatch an unchanged provider-rejected fingerprint automatically.
6. Exercise model/tool-policy/system/Skill/checkpoint changes, schema cache invalidation, cancellation, timeout, protected oversized input and a subsequent smaller input. Provider options, subscription thinking behavior, Sampling and API provider behavior must remain unchanged.

Task 2 must stop for independent implementation review before Task 3 is authorized. Task 3 must independently pass before Task 4. Final Phase 1 acceptance requires diagnostics integration, relevant complete regressions, typechecks, lint, builds, changesets and the planned Core E2E. Mock SDK/SQLite tests are not real subscription acceptance or evidence of compression efficiency.

## Navigation limits

GitNexus `roll-agent` is registered at the current HEAD with an index dated 2026-10-10. The previous read-only concept query did not return a useful flow and the named private compaction method did not resolve. Source and installed SDK inspection therefore remain the evidence for this pre-review; missing graph results are not interpreted as absence of callers or low risk. Shared AgentSession dispatch/recovery remains a high-risk review area. No production symbols were edited.

## Installed-SDK revision acceptance

Roll subsequently delivered `docs/plans/2026-10-12-context-request-budget-sdk-checkpoint.md` and stopped for review. Codex independently reproduced its SDK premise with `/tmp/codex-roll-task2-sdk-review.mjs`: initial guard 0 Provider calls/0 tools/0 completed steps; intermediate guard 1 Provider call/1 tool/1 completed step. Both preserve the identical owned marker in the stream, while the initial `steps` promise substitutes a generic error. Start callbacks run before a rejected dispatch and have no matching successful end callback. Dynamic description resolution was performed by SDK only (2 calls per prepared attempt in this fixture). The script passes its assertions with the installed SDK; it is not a production Task 2 test or real subscription acceptance.

Decision: approve finalized-SDK parameters as authoritative request structure and defer finalized post-maintenance accounting until actual re-preparation, with all counts still labeled estimates. The checkpoint's section 6 records acceptance requirements for frozen calibration, absent/pending after-budget on cancellation, bounded preparation/recovery, dynamic shape invalidation, coordinator lifecycle and durable no-replay tests. No `ai/internal` production coupling or duplicate download/conversion pass is needed. Implementation acceptance remains pending.

Communication status: the written decision is saved in the shared workspace. No prompt was sent to the stopped Roll session because the Metalterm access tool refuses approval. No scheduler was resumed.
