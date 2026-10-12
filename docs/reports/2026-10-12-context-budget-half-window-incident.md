# Half-window interruption: independent incident review

Date: 2026-10-12. Shared checkout HEAD: `31816c3a88c250565dafa5032eb9e5d645c7ceb8`.

**Verdict: reopen Task 2 acceptance for a reproduced liveness regression.** The new Task 2 guard can terminate a healthy multi-step turn while its latest measured input is 50% of the configured window. Task 3 remains unfinished and unaccepted. This is not explained away as a normal protection message or merely different UI units.

**Later implementation update:** the user reassigned implementation to Codex. The reproduced regression and Task 3 are now implemented and locally verified, awaiting acceptance; see [delivery report](2026-10-12-context-compaction-task3.md). The analysis below describes the failing snapshot and preserves its attribution limits. The running Roll host was not restarted.

## Live evidence and attribution limits

- Metalterm shows `context_request_budget_unrecoverable` immediately after writing `compaction-recovery.test.ts`, with `ctx 259.9k/500k (49% left)`. The input is idle. The completed tool messages are retained through transcript sequence 983 in the explicitly authorized thread `6ae73b8d-e223-4187-97be-4eadd7315850`.
- PID 28911 is the development CLI `node ... packages/core/src/cli/index.ts -- chat --last`, started 2026-10-12 13:31:23 Singapore. Its runtime uses ordinary imports, not hot reload. The accepted Task 2 snapshot was preserved at 13:37; the ongoing Task 3 source edits were made around 13:59–14:01. These times and the unchanged process support attribution to the loaded Task 2 guard rather than newly written Task 3 code.
- The exact denied budget, pause reason and recovery counter are process-local and were not persisted. The live database has zero runtime event rows for this thread. No trace log is open by the CLI. We did not attach a debugger, restart the process, alter its configuration or modify its thread database.
- Persisted messages intentionally omit reasoning parts. Therefore their replay cannot recover the exact rejected in-memory request, especially encrypted reasoning data. **The encrypted-field route below is independently reproduced and relevant to the live ChatGPT adapter, but is not claimed to be the uniquely proven cause of this particular live stop.** Exact live encrypted length and last per-step Provider usage are unavailable from the retained evidence.
- Numeric-only offline inspection: 546 persisted messages produce an SDK-prepared message estimate of 413,386 tokens. A minimal Session reconstruction including checkpoint 29, default system and no installed tools estimates 419,468; its 500,000-window ceiling is 481,808 and it dispatches to the mock. These are partial reconstructions, not the live full budget or real tokenizer counts. Disk bytes are not tokens.

## Reproduced causal chain

1. `request-budget.ts:estimate` recursively counts strings as UTF-8 bytes / 3.5. For keys matching encrypted/signature/fileId it still counts the string and merely sets `opaqueOrMultimodal`. The uncertainty flag does not change admission. Thus an encrypted provider representation is converted into a hard token estimate by its serialization length.
2. `RequestBudgetTracker.measured` stores `max(0, measured - raw)`. Calibration can raise an underestimate but cannot correct an overestimate, even with a matching successful measurement. A focused tracker probe gives raw 10,333, measured 5,000, matched true, residual 0, calibrated 10,333, ceiling 9,300: the unchanged known-successful request would be classified unsafe. This is also a limitation of the approved plan formula, not solely a coding typo.
3. The Task 2 stream guard sets `ownedPause` from that estimate. Its recovery handler persists the completed canonical tools and strips reasoning. It then tests **whole-turn `guardedRecoveries >= 4` before another actual SDK preparation can verify the reduced request**. Successful previous recoveries never reset that quota. The fifth recoverable pause becomes `context_request_budget_unrecoverable`.
4. ChatGPT transport explicitly requests `reasoning.encrypted_content`; installed OpenAI SDK maps it through `reasoningEncryptedContent` into subsequent reasoning input. The fixture uses that actual SDK metadata key. It does not count all billed reasoning tokens as future input or send a real subscription request.

The guard failure is a product regression even though provider token counts in the reproducer are controlled mocks: its own earlier recovery passes demonstrate fitting requests, six tool operations settle once, and a short follow-up immediately dispatches the preserved state and completes without repeating them.

## Controlled comparison

Same six-tool workload, 10,000-token window, Provider reports 5,000 input tokens each step, no Provider overflow. Control differs only by adding 25,000 characters of opaque encrypted reasoning metadata to each generated reasoning part.

| Runtime | No encrypted metadata | With encrypted metadata |
| --- | --- | --- |
| Pre-Task-2 AgentSession from HEAD | 7 Provider calls, 6 tools, completes | 7 Provider calls, 6 tools, completes |
| Accepted Task 2 snapshot | 7 Provider calls, 6 tools, completes | 6 Provider calls, 6 tools, stops before final answer |
| Current Task 3 WIP | 7 Provider calls, 6 tools, completes | Completes this fixture; not Task 3 acceptance |

The baseline comparison replaces only AgentSession in an isolated runtime source copy; dependencies and the accepted pre-Task-3 helper snapshots stay fixed. This isolates the new session guard rather than claiming an exact historical full-repository build. Main Task 2 reproduction first ran uninstrumented; a second isolated copy adds a numeric log at the existing refusal branch without changing decisions.

Logged Task 2 refusal: reason=`budget`, recoveries=4, repeated fingerprint=false, raw=11,655, calibrated=12,322, latest measured=5,000, opaque=true, ceiling=9,300. Earlier rebuilt requests were calibrated 5,143 and admitted. After the stop, same-session `continue` gives raw/calibrated 4,510, calls=7, effects still=6, and completion. No completed tool is replayed. Assertions verify these counts and the expected stop/control results.

Local evidence:

- `/tmp/codex-task3-baseline/manifest.json`: accepted Task 2 file hashes.
- `/tmp/codex-budget-half-window-repro.mjs`: SDK/AgentSession multi-step reproduction.
- `/tmp/codex-budget-half-window-{head,repro,task3-wip}.log`: comparisons; repro includes numeric branch log and successful follow-up.
- `/tmp/codex-budget-incident-runtime/`: isolated source copy; no working-tree production edits.
- `/tmp/codex-budget-incident-snapshot.mjs`, `/tmp/codex-budget-incident-projection.mjs`: read-only persisted-history numeric reconstructions.

An initial offline reconstruction mistakenly wrapped `content_json` (already a complete message) a second time; it failed SDK validation and was corrected before the numeric results above. That fixture error is not a product defect.

## Misleading status during interruption

`packages/core/src/cli/chat/ink/state.ts` handles `step-finish` by clearing tool-generation state but ignores its usage. Only `message-finish` replaces `contextInputTokens`. The Task 2 owned-pause path returns its error without emitting the latest `message-finish` occupancy. Consequently the displayed 259.9k may belong to the last completed stream segment, while many later tool steps ran. The screenshot does not prove the exact next request has 49% free. This stale display is an additional observability defect; it does not excuse the reproduced liveness failure.

## Correction and acceptance direction

- Revisit admission calibration and opaque representation handling. Preserve raw diagnostic components and uncertainty; do not equate ciphertext byte length with known model occupancy. A compatible successful measurement must have a sound way to correct systematic overestimation. Do not blindly assign opaque input zero tokens or bypass a genuine Provider-confirmed overflow.
- Keep admission separate from frozen before/after comparison: calibration changes alone must never prove space release. Retain unknown-window rejection reduction, compatible epoch checks, cancellation ownership and no-replay protections.
- Replace the whole-turn recovery cutoff with bounded episodes, already authorized by Task 3. After settling/persisting and canonical rebuilding, reserve an actual guard verification; an exhausted work allowance must not reject a now-fitting request based on a stale pre-rebuild budget. All repeated preparations/summary attempts still need bounds.
- Update occupancy from real step usage or clearly label its age. On a guard error, surface a concise numeric reason (estimated input, ceiling, opaque uncertainty / exhausted recovery) through the existing error/status channel. This scoped repair does not authorize Task 4 diagnostic tables, retention or public protocol expansion.
- Required regressions: this encrypted-metadata fixture, matching-measurement overestimation, successful repeated maintenance in one turn, final fitting preparation at cost exhaustion, true oversized/Provider-rejected requests still blocked, cancelled-owner isolation, and six settled operations retained exactly once. Re-run the original Task 2 regressions and complete Task 3 validation after a stable delivery.

Task 2's previous acceptance evidence remains historical and valid for those tested cases; the current acceptance verdict is reopened by this new case. Keep Task 4 unopened. No staging, commit, push, publication, restart, settings or automation changes were performed.

## Handoff state

The correction-design request was submitted to idle Metalterm and is durably accepted as user transcript sequence 984 at 2026-10-12T07:41:21.051Z. The subsequent CLI attempt stopped with a separate authentication error: `无法获取 ChatGPT 身份签名密钥，请稍后重试；现有凭证已保留。` No design response or correction implementation was produced. This new authentication failure is not evidence about the earlier context-budget refusal. The process and credentials were left unchanged.
