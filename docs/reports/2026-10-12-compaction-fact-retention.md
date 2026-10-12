# Task 3 follow-up: fact retention before space recovery

Status: fact-retention fix and bounded space optimization implemented and locally verified. Both live coding variants passed; real space recovery remains limited in the tested case. Ready for user acceptance, with the limitations below. Task 4 remains out of scope. Changes are uncommitted on the existing `dev` checkout based on `31816c3`.

## Why facts disappeared

The old semantic evidence path clipped message/Tool evidence to 512 characters, then presented only 256 characters to the summarizer. The separate raw-prefix prompt was also bounded by head/tail clipping. Even when the model proposed a correct middle/tail fact, validation reconstructed its authoritative text from the short source quote. Coverage could then retire the full message. SQLite still contained the evidence, but the next model request did not contain the fact.

This predated Task 3. Task 3 bounded maintenance and verified request admission; it did not introduce the original evidence-clipping problem. The previous evaluation records its reproduction against the pre-Task-3 semantic implementation.

## Changes

- Summarize batches now present entire selected sources, including Tool input/result strings with preserved line breaks. No duplicate clipped raw prefix is added. The 32-entry batch bound remains. A window-dependent 1,024–256,000 character bound limits summary inputs; default unknown-window input bound is 48,000 characters.
- Long sources permit exact complete line/sentence quotations (up to 512 characters each). The runtime still derives retained facts from validated quotes rather than trusting a paraphrase. Long-source retirement requires explicit complete review and accepted facts; uncertain, missing, and rejected claims do not retire their source. Explicitly irrelevant assistant filler may be retired. Long user and Tool evidence cannot be dropped simply by calling it irrelevant.
- Structured Tool strings retain their line boundaries, so a middle/tail fact is actually quotable. Retained Tool results are no longer automatically truncated in summarize mode.
- Invalid summary output keeps source history. Semantic overflow or facts missing from the next checkpoint reminder also prevent installation. The explicit user-selected truncate strategy remains available with its previous behavior.
- Repeated identical messages are matched to their active transcript occurrence when checking removable coverage; already-covered active history can subsequently be retired without manufacturing coverage.
- Identical text and quotes are not repeated in the model reminder. Durable quote/provenance records remain intact.
- Automatic summarize maintenance still triggers at the configured threshold (75% by default), then aims for half that threshold (37.5%) within the existing bounded episode. This is advisory: fitting requests continue when further safe reduction is unavailable. Oversized unpresentable source evidence also leads to final SDK admission verification instead of automatically rejecting a fitting request.

The 8,000-character semantic reminder cap and 32,000-character overall reminder cap are unchanged. The lower recovery target does not override current-turn protection, evidence retention, cancellation, time, or step limits. No Task 4 diagnostics/protocol expansion was added.

## Offline production-path comparison

These are deterministic mock summaries and inference, with the actual AgentSession, SDK preparation, checkpoint and SQLite paths. Percentages use the runtime's request estimate, not provider token usage. They are not a coding quality score.

| Fixture | Window | Before fix: post-compaction occupancy | After fix | Key facts in next request |
| --- | ---: | ---: | ---: | --- |
| 30 long turns | 500k | 41.60% | 27.98% | 3/3 |
| 40 long turns | 500k | 52.66% | 34.01% | 3/3 |
| 40 turns + 40 Tool ledger entries | 500k | 67.20% | 34.11% | 3/3 |
| 100 turns | 500k | 72.22% | 58.88% | 3/3 |
| 40 long turns, smaller window | 350k | 30.91% | 36.77% | 3/3 |

Previously the middle and tail markers were absent from the next request. The smaller-window fixture now consumes more context because it retains facts and unreviewed sources that the prior implementation lost. The dense 100-turn fixture stops above the target when adding more facts would exceed the reminder. Neither case is represented as meeting the recovery target.

Reproduce:

```sh
node --experimental-strip-types --experimental-sqlite scripts/bench/compaction-retention.mjs --output /tmp/compaction-retention.json
```

Results: `docs/reports/2026-10-12-compaction-fact-retention-results.json`.

## Validation

- Runtime full suite: 1,594 passed, 17 skipped, 0 failed (1,611 tests).
- Six targeted fact tests: exact middle/tail quotes, negation/invention rejection, incomplete-source preservation, real production Tool evidence, malformed summaries, SQLite reopening, and fact visibility in the next prepared request.
- Additional admission test proves a source too large for summary input remains intact while a fitting actual request can still proceed.
- Runtime typecheck and build passed; scoped ESLint and diff checks passed after formatting.
- Existing test expectations that required silent truncate fallback were changed to assert preserved history and checkpoint stability. Long-evidence fixtures now explicitly review complete sources. Existing truncate, no-replay, cancellation, and restoration behavior is still exercised by the full suite.
- GitNexus index refreshed. `detect_changes(scope=all)` reports CRITICAL (13 changed symbols, 1,044 affected processes, 34 tracked files including concurrent work), without a partial/truncated response flag. The index itself reports unresolved/capped call-resolution and flow enumeration; graph coverage is not proof of no risk. No commit was made.

## Live coding evaluation

The opt-in `scripts/bench/compaction-coding-quality.mjs` uses the current configured ChatGPT account, model, and reasoning settings. It creates isolated temporary coding workspaces, supplies the same seeded long history to uncompressed and compacted variants, and uses real model requests, file reads/edits, and independent assertions. It does not modify the project or user settings.

The task implements a retry planner with historical constraints including the exact 1739ms cap, Retry-After above the cap, budget equality, strict input validation, and no retry for unknown outcomes. Fourteen assertions test actual code behavior. Fixtures and SQLite evidence are retained for review.

The existing configured model at execution time was `gpt-6.1-sol`, normal and summary effort both `medium`. No settings were changed.

| Live variant | Real code checks | Session result | Summary calls | Model inference requests |
| --- | ---: | --- | ---: | ---: |
| Uncompressed control (rerun) | 14/14 | Completed, no errors | 0 | 4 |
| Compacted | 14/14 | Completed, no errors | 2 | 4 |

Both produced only the required `planRetry` export and passed the exact cap, Retry-After, input validation, budget equality, immutability and no-replay checks. The compacted run actually retired six messages and continued using a committed checkpoint. The first control attempt also produced code passing all 14 assertions, but its session then returned an execute-stage error; that initial recorder did not retain its message. It is recorded as interrupted, not silently counted as a successful completion. The control was rerun successfully with error diagnostics enabled.

Space recovery in the live compacted sample was modest: the before/after maintenance estimate was **114,356 → 99,491**, a **13.0% reduction** (89.3% → 77.7% of the deliberately configured 128k evaluation window). It stopped with `advisory_target_miss` and still admitted the fitting request. The first committed summary arrived about 77 seconds into a 120-second maintenance allowance; a second summary was attempted without another commit. This supports a cost-limited maintenance concern, but the initial recorder did not capture enough per-summary detail to conclusively distinguish timeout from candidate rejection. Do not claim that this real run achieved the 37.5% target or solved all post-compaction occupancy concerns.

The final calibrated request estimate became about 50.7k after provider usage calibrated the estimator. That later calibration change is not additional compression and must not be counted as released context.

Results and temporary workspace paths: `docs/reports/2026-10-12-compaction-live-coding-results.json`. Reproduce both variants with:

```sh
node --experimental-strip-types --experimental-sqlite scripts/bench/compaction-coding-quality.mjs --run --output /tmp/compaction-live-coding.json
```

`--variant uncompressed` or `--variant compacted` runs one variant; `--preflight` checks the existing login. These are opt-in live provider requests. Temporary fixture source and SQLite evidence are retained. The 128k evaluation window is local to the fixture and does not change user configuration.

This is a small controlled coding sample with seeded long history, not proof of equal quality on arbitrary sustained repository work. The demonstrated fact-loss defect is fixed, and the sampled post-compaction code quality passed. Space recovery is improved in four of five offline fixtures, but remains a **qualified result**, not complete performance acceptance.

## Remaining boundaries

A model's declaration that it reviewed all material facts is not a formal proof of semantic completeness. The new path removes the demonstrated mechanical loss, validates exact quotations, and refuses known incomplete/overflowing replacements. A single source larger than the bounded summary input, or a set of facts larger than the bounded reminder, is preserved rather than aggressively compressed. This can still leave occupancy above 40–50% for some conversations. Multi-part source review and a larger working-state/retrieval design would be separate follow-up work, not silently included in Task 4 here.
