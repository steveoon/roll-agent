# Context compaction: final dev review

**Follow-up correction:** the subsequent review reproduced cumulative checkpoint
retention blocking compaction and repeated advisory maintenance across Tool steps.
The original test matrix below missed those scenarios. See
[the corrective review](./2026-10-12-context-compaction-review-followup.md) for the
reproductions, fixes and new validation. The original conclusion is historical,
not the final assessment of `7792a1b`.

Reviewed the pending context-compaction changes on `dev` above `ece7908`, including
input acceptance, SQLite receipts and fork/resume, finalized SDK request admission,
maintenance limits, settled Tool persistence, semantic evidence retirement, and
summary request sizing. Also checked integration with the committed ChatGPT
connection recovery and the pending Tool-input status UI.

No new P0/P1 finding was substantiated. No additional production changes were made
during this review. This is a scoped review of this change set, not a claim that
every path in the repository is defect-free.

## Commit boundary

- Includes Tasks 1–3 context reliability, the subsequent fact-retention and batch
  efficiency fixes, their tests, Changesets, benchmarks, and historical reports.
- Includes the Core latest-step context counter and the ChatGPT failed-auth input
  retention integration test.
- Excludes the pending Tool-input generation status implementation and its
  Changeset. Its edits in the two shared files remain unstaged. Historical Task 1a
  notes remain documentation of the broader working-tree investigation.
- Separate authentication investigation reports remain uncommitted.
- Task 4 remains unimplemented. No push, publish, or user-session restart.

## Verification of the exact staged source

Constructed an isolated source snapshot from `HEAD` plus the staged patch. Workspace
package links resolve within that snapshot; only installed third-party dependencies
are shared. The unrelated Tool-input status files are absent from the snapshot.

| Check | Result |
| --- | --- |
| Runtime tests, concurrency 4 | 1,593 passed, 17 skipped, 0 failed |
| Core source tests, concurrency 4 | 1,864 passed, 5 skipped, 0 failed |
| Core UI tests | 84 passed, 0 failed |
| Protocol tests | 48 passed, 0 failed |
| Core E2E, concurrency 2 | 75 passed, 0 failed |
| Runtime, Core and Protocol typecheck | Passed |
| Whole-repository ESLint | Passed |
| Prettier on changed TypeScript and benchmark scripts | Passed |
| Runtime and Core production builds | Passed |
| Built CLI `agent health` with an empty temporary registry | Passed: no registered Agents |
| Staged whitespace check | Passed |

Total: 3,664 passed, 22 skipped, 0 failed. Logs are local files matching
`/tmp/roll-dev-review-*.log`; the source snapshot path is recorded in
`/tmp/roll-dev-review-snapshot-path`. The first CLI smoke invocation put `--config`
before the subcommand and was rejected by argument parsing; the corrected invocation
ran `agent health` from the isolated configuration directory and passed.

GitNexus staged change analysis reported CRITICAL reach through the session engine,
request accounting and store. It returned no top-level partial/truncated flag. Its
static resolver and process-sampling limitations remain, so the graph is navigation
and impact evidence, not proof of complete regression coverage.

## Remaining limits and timeout clarification

The default compaction timeout is 120,000 ms. Automatic maintenance shares one
absolute deadline across its summary batches, also bounded by the remaining turn
deadline. Thus a first batch taking about 69 seconds leaves about 51 seconds for
the next batch; it does not receive another full two minutes.

The prior real-model coding results remain the applicable behavioral evidence:
14/14 functional checks in both paired variants, with 70.14% estimated release in
the compacted variant; the dispersed-fact sample retained all five fact groups and
released 72.71%. These controlled histories are not a universal quality guarantee.
This review did not repeat paid model calls because it changed no production logic.

Dense facts may still exceed the bounded checkpoint reminder. The implementation
then retains source history, so the achieved compression ratio can remain lower.
This retention boundary was preserved rather than relaxed for a better ratio.
