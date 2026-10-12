# Context compaction review corrections

Review baseline: `7792a1b` plus the separately pending Tool-input status UI.
This follow-up addresses the two substantive findings and the related Runtime
stream lifecycle issue. Task 4 and the Tool-input UI work remain outside the commit.

## Confirmed findings and changes

1. The cumulative retention check made historical completion records a permanent
   compaction barrier. Production-path tests with 40 and 128 existing completion
   records reproduce `removed: 0`. The retention check now requires new candidate
   facts to remain in both the merged checkpoint and its actual reminder. Historical
   completions use the pre-existing bounded-state/`omittedCounts` contract; previous
   checkpoints and raw transcript remain recoverable. Active categories are projected
   before historical completions, existing visible active facts cannot be crowded out,
   and new candidate pruning or additional active-fact pruning still rejects the draft.
   Invalid or incomplete summaries still retain their sources. No silent truncation
   fallback was introduced.
2. `softAttempted` was never populated. A real SDK/Tool-loop fixture with four Tool
   steps opened five maintenance episodes. A turn-local advisory-miss baseline now
   suppresses repeated soft maintenance until growth reaches `max(1024, 5% of window)`
   tokens or the finalized request configuration changes. The predictive stop uses
   the same backoff. Raw and calibrated growth are checked at dispatch; hard-limit
   and Provider-rejection checks always run. The obsolete no-op preliminary
   compaction method and its dead control flow were removed.
3. Rebuilt streams emitted repeated message starts without finishing the earlier
   logical message. Runtime projection now reuses an open stream identity and preserves
   its text. A real message finish clears that identity; failure/cancellation closes
   any remaining partial stream before emitting the separate turn outcome.
4. An 8,192-token summary output reservation made an 8k window unusable even for
   small evidence. The effective summary output ceiling is now the smaller of the
   configured limit and one quarter of the known window. Packing and actual SDK
   dispatch use the same ceiling; schema/options/error reserves remain counted.
   Windows too small even for that complete request are still rejected.

## Regression coverage

- Resume 40/128-completion checkpoints, compact twice, make a normal model request,
  reopen SQLite, and verify old checkpoints/raw facts remain recoverable.
- Cross the 128-completion storage bound while retaining the new completion;
  reject missing new facts, excessive new facts, and additional active-fact pruning.
- Four Tool steps with no material growth: one maintenance episode and one summary,
  while all five normal model calls and four Tool executions complete.
- Material Tool-result growth: a second maintenance episode is permitted.
- Hard-limit Tool-result growth: dispatch stops before the third model call; the
  advisory backoff does not bypass admission.
- Small-window summary reaches the Provider with an output reservation at most 2,048;
  unpresentable schema/options continue to fail before Provider dispatch.
- Runtime message streams pair correctly on success, failure and cancellation, and
  preserve text emitted before an internal rebuild.

The three input-persistence fault tests formerly monkeypatched the removed no-op
method. They now inject at `runCompaction`, reached through the real finalized SDK
guard, and retain their no-dispatch/exactly-once/next-turn assertions.

## Scope and limits

GitNexus was refreshed against the current repository. AgentSession and RuntimeService
impact remained CRITICAL; function-level resolution was incomplete and was checked
against actual imports/call sites. The staged/all change analyses returned no
`partial` or `truncated` flags and retained a CRITICAL verdict. This does not remove
the indexer's separately reported process-sampling and resolution limits.

The storage/query N+1 optimization, unreachable legacy cancellation branch and UI
style suggestions are deferred. Truly excessive new or active facts can still prevent
safe compaction; this is a capacity boundary, not merely a low compression ratio.
This change removes the historical-completion barrier without promising that arbitrary
facts can all fit in a finite reminder. Real-model coding benchmarks from the preceding
turn are historical evidence and were not rerun in this follow-up.

## Final verification

The exact staged source was exported to an isolated temporary checkout, excluding
the pending Tool-input UI changes, and verified with the repository's Node 24.21.0
and pnpm 11.24.0 toolchain:

| Check | Result |
| --- | --- |
| Runtime full suite | 1,603 passed, 17 skipped, 0 failed |
| Core source and UI suites | 1,948 passed, 5 skipped, 0 failed |
| Protocol | 48 passed |
| Relay Client | 37 passed |
| Node Client | 67 passed |
| Runtime and Core typechecks | Passed |
| Repository lint | Passed |
| Runtime production build | Passed |

Total: 3,703 passed, 22 existing skips, no failures. This includes ten new regression
cases for retention, maintenance backoff, small windows, hard admission, and stream
lifecycle. Core E2E and real-provider coding benchmarks were not rerun in this review.
Logs are `/tmp/roll-corrections-{runtime,core,clients,types,lint,build}.log`.

The corrective commit is local only. No push, release, user-session restart,
configuration change, or Task 4 implementation is included.
