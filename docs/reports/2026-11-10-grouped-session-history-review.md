# Grouped session history review

## Prior issues → status

- Medium, confirmed, fixed and reverified: grouped Ink history exceeded a 6-row budget by one row (and a 7-row budget when displaying an error). Pagination is now omitted when necessary; a one-row content budget combines the group and selected conversation. Regression tests exercise 5/6/7 rows with and without errors and scroll to the last entry.
- Low, fixed and reverified: the timestamp-preservation test previously used a fixed clock. It now advances the clock before assignment and again before idempotent retry; a mistaken timestamp update would fail snapshot equality, including after reopening the library.
- Follow-up design correction, implemented and independently reverified: the active conversation is included and marked `[当前打开]`, initially focused. Enter returns without reopening/closing it. Current old history can be assigned in place; failed assignment preserves that active instance and its lease. An explicitly opened cross-project active conversation remains visible without becoming assignable.
- Visual follow-up: history titles remain unmodified; current/open, occupied and unknown states are rendered in a dedicated status column. Structured occupancy comes from the existing Protocol type. Responsive columns, counted section rules, optional spacing and a single action bar were verified at widths24/40/60/100 and row budgets5/6/8/12, including every selected row. Plain model/scheduler picker entries keep their generic row path.
- Independent visual follow-up review: formatter/picker17/17 and 48 extra layout cases with long multiline titles, emoji, combining characters and long client names passed. No unresolved width, status, action-bar or plain-picker compatibility finding.

## Review scope

Working-tree implementation on `dev`, based on `ef1b8f5e4e6fe21796e9827c7b090860b28d9bad` (main merged into dev). Includes Core picker/REPL changes, Runtime workspace assignment, regression tests, docs and Changeset. Imported main history is excluded. macOS, Node24.21.0, pnpm11.24.0.

## 理解（问题 → 方案）

Project-only `/resume` hid old unclassified conversations. The default history picker now groups current-project and old unclassified history together. An explicit action resumes an old thread under its existing session claim, then assigns only workspace metadata. Assignment failure closes the new target while preserving the active session. Runtime owns validation and persistence; Core owns canonical project identity and terminal interaction.

## Scorecard

| Axis | Score | Evidence / reason |
| --- | --- | --- |
| Correctness | 9/10 | NULL-only assignment, peer exclusion, failure cleanup and retry verified |
| Design / Architecture | 9/10 | Neutral Runtime API; project discovery and UI stay in Core |
| Testing | 8/10 | Complete local failure/success coverage; native Windows/Linux execution pending |
| Operability | 9/10 | Current session remains usable after refusal/write failure |
| Docs / Contract | 9/10 | Docs and Core/Runtime minor Changeset match behavior |
| Complexity / Maintainability | 8/10 | Shared picker reused; grouped viewport adds bounded, tested complexity |

**Overall: B+ (8.7/10), provisional** — independent review has no unresolved findings. Raw aggregate 52/6, no severity caps applied. Rubric: Google-inspired engineering principles and the benchmark-code-review local six-axis anchors.

**Merge disposition:** Ready within the locally verified scope; cross-platform CI remains to be run when the changes are pushed.

## Findings

No unresolved Critical, High, Medium or Low findings. Both prior findings above were fixed and independently reverified.

## Design notes

- Ownership is acquired before changing workspace. A peer-held or unverifiable claim refuses assignment; neither process is terminated.
- Runtime validates the bounded workspace string, accepts only unclassified interactive history, and rejects overwriting a different project or modifying scheduled execution provenance. Same-target retries are idempotent.
- Assignment changes neither recency nor transcript/checkpoints/tool records/events. The existing schema already has the workspace column.
- Existing model and scheduler pickers remain plain because they supply no history grouping/assignment metadata. All-project flags remain optional compatibility access to other projects.
- Auto-assigning on ordinary resume was rejected because resuming from a different directory must not silently move history. Direct SQL in Core was rejected because ownership and storage belong in Runtime.
- Security: parameterized SQL and existing claims; no new network, authentication, credentials or Protocol surface. No policy/redaction regex change. Command and keyboard string gates were traced through both REPL paths.

## Verification performed

- Independent focused formatter/Ink picker/Runtime workspace checks: 19/19; independent intent/retry and real CLI scenarios: 1/1 each. Final clock regression recheck: 6/6.
- Final Core formatter/picker/App/commands regressions after the visual follow-up: 150/150. Independent current-session return/assignment checks from the prior review remain applicable.
- Complete Runtime suite: 1,728 passed, 18 platform skips, zero failed/cancelled.
- Complete workspace real CLI E2E file: 9/9, including a peer-held claim, assignment to an already-active conversation, and a SQLite trigger that aborts assignment after target resume. Verified target claim release, current claim retention, retry, original ID/context and project `--last` after restart.
- Production Ink CLI under a real isolated PTY: both groups visible, other project excluded, explicit `m` assignment persisted, prior context restored, clean exit0.
- Follow-up real CLI: current old conversation remains occupied and usable after a SQLite assignment failure, retries assignment in place, and continues the same context/ID after success. Real Ink PTY also verified active marking, Enter returning directly and reopening the full list.
- Core/Runtime typecheck, repository lint, affected formatting and Core build passed. Built CLI lazy-loading smoke passed with an isolated empty HOME.
- Final GitNexus change analysis is non-partial and non-truncated. Its CRITICAL fan-out warning includes the shared ThreadStore/REPL paths across the cumulative feature diff; this is a change-risk assessment, not a confirmed defect. Runtime assignment and failure cleanup were verified through production Runtime/CLI paths; the visual follow-up only changes Core presentation/data projection. The new untracked history-row helper, Changeset and report were separately inspected and covered by the build/tests.

## Unverified coverage

- Applicable checks not run: native Windows/Linux execution and hosted CI for this unpushed change; full monorepo tests and packed tarball audit. Current evidence is local macOS, targeted Core and complete Runtime/workspace E2E coverage.
- Untraced integration: Desktop UI does not consume this CLI action; no Desktop or public Protocol mutation interface is added. React/lazy-load edges unresolved by the graph were checked through source and executed UI/CLI tests.
- Non-applicable protocols: Relay/public wire/authentication/provider requests are unchanged.

## Residual risks / follow-ups

Cross-platform CI should run before merge. Windows already executes the changed workspace E2E file in its explicit CI command. The installed release remains separate from these development-source changes.
