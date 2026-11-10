# Roll Chat workspace/configuration review

## Follow-up: onboarding source and unavailable reload

Review scope: current `codex/chat-workspace-experience` working tree based on `4a2af7dce284ac8f7ccb3f57d36145e62c3353ad`. This follow-up changes Core wiring and tests/documentation only; it adds no Runtime configuration parsing or new Runtime/Protocol state.

| Prior P2 | Status | Current evidence |
| --- | --- | --- |
| Explicit configuration is lost by onboarding | fixed | Real CLI follows the selected file through detection, model credential write and execution; conflicting project configuration is byte-for-byte unchanged. Unit regressions exercise configured/unconfigured sources, projected Agent data directory, selected registry and start environment. |
| Reload without a bound source permanently closes admission | fixed | Missing Core read capability is rejected before calling the Runtime controller. Snapshot/revision and an existing guard stay unchanged; operations and session-only model changes remain available. Real ChatGPT CLI sends two successful local HTTP requests after reload attempts, including after creating an unrelated new config file, and retains the first input in the second request. |

Onboarding also refuses a selected file deleted while confirmation is open, and the CLI reloads the same pinned context after the wizard. Source options are optional on shared setup helpers, preserving ordinary `roll setup` / `roll config setup` defaults and existing document revision/CAS behavior.

### Verification performed in this follow-up

- New regressions first failed against the previous implementation, then passed after the changes.
- `pnpm --filter @roll-agent/core test`: 2,217 tests, 2,212 passed, five existing skips, zero failures.
- `pnpm test:e2e`: 110/110 passed, including the two new real CLI scenarios in `smoke-chat-config-recovery.e2e.ts`.
- `pnpm typecheck`, `pnpm lint`, changed-file formatting, source-control-character check and `git diff --check` passed.
- Core build and compiled `agent health` lazy-loader smoke passed in an isolated HOME. Changeset status retains the feature's existing minor releases and dependent patch propagation.
- Fresh GitNexus analysis with a temporary Git index included all 62 files and 21 new files without changing the real staging area. It reported 358 changed symbols, 985 potentially affected processes and critical shared-surface risk; dynamic/callback edges were checked with source and executable integration tests rather than treated as proven paths.

The CLI fixtures isolate HOME/config/history, block external model fetches, use fake subscription credentials, and trace local HTTP requests. Onboarding answers are scripted through the prompt adapter; TTY eligibility is enabled only for entry into the wizard and restored before the real piped REPL. npm metadata resolves against a local fixture registry and no Agent package is installed. The first versions of the new TTY fixture lacked native stream methods; the final fixture restores piped stream semantics and the complete final E2E run passes.

### Review findings and design notes

No open Critical, High, Medium or Low findings were identified after these fixes. The fixes distinguish an unavailable host capability from a failed application of a selected source, without weakening the existing Runtime failure barrier. Passing Core source/resource options through existing loaders and `ConfigApplicationService` is preferable to changing cwd or passing product configuration into Runtime. Optional source arguments preserve shared setup callers; no unused abstraction or new dependency was introduced.

Security/error-path checks covered destination preservation, selected-file deletion, Agent environment/source consistency, credential write location, repeated unavailable reload and retained conversation identity. Existing invalid/deleted bound-source recovery remains covered by the full CLI E2E suite. No new regex/content/policy gate was introduced in the follow-up; previous bounded metadata/cursor checks remain applicable. Signing/payments, archive extraction and CI/dependency changes are N/A for these fixes.

Updated six-axis scores: Correctness 9, Design / Architecture 9, Testing 8, Operability 8, Docs / Contract 9, Complexity / Maintainability 9. Raw/final aggregate: 8.7/B+ (provisional); no blocker cap applies. Local review passes; merge disposition remains Not assessed until platform CI. Native Windows/Linux, Node 22, native terminal rendering, real Desktop packages and the live ChatGPT service remain unverified. Third-party embedding hosts and real Agent installation were not executed. No real user data or existing installations were changed, and this branch remains uncommitted/unpushed.


## Scope and disposition

Working-tree review on `codex/chat-workspace-experience`, based on `4a2af7dce284ac8f7ccb3f57d36145e62c3353ad` (dev). Includes authored source, new tests, public exports, docs and Changeset; generated dist is built and audited rather than committed. No dependencies or lockfile changes. Independent read-only reviewers inspected cross-package contracts and safely reproduced cancellation with localhost HTTP. Current open findings: none. Local review passes; merge readiness remains provisional until platform CI completes.

The change gives normal chat a pinned config source, shared model reload coordination, persisted workspace attribution and read-only cross-client browsing. Core owns path/config/provider/auth interpretation and terminal UI; Runtime owns storage, execution/ownership barriers and model revision coordination; Protocol/client-node expose bounded optional metadata without modifying frozen summaries.

## Prior findings and resolution

| Finding | Evidence | Resolution |
| --- | --- | --- |
| Async configuration notices clear a draft | Executed Ink regression through `commit-history` reducer | `preserveDraft=true`; user input remains after pending/applied notifications |
| Older async Fast/model preparation can overwrite a newer reload | Exact async prepare/commit interleaving and executable stale-guard tests | Capture configuration identity/status and validate it again before commit; pending/failed admission stays blocked |
| Deferred ChatGPT resolution falsely reports an unavailable model applied | Executed real resolver with isolated auth/catalog | Prepare helper validates exact account catalog, model, normal/compaction effort and Fast before commit |
| Basic REPL token display retains old context window | Real renderer regression with changed/unknown window | Read the current session's window rather than the startup window |
| Close abort does not reach ChatGPT catalog HTTP | Same delayed localhost HTTP repro before/after fix | Signal traverses CLI → prepare helper → authenticated catalog helper → auth.models; checks after await and before commit |

Final cancellation repro: `modelRequestReceivedSignal=true`, `signalAborted=true`, `requestStillOpenAfterClose=false`, `fetchCompleted=false`, `committed=false`. All assertions passed. No real credentials, paid model requests, installations or user history were used.

## Invariants and alternatives

- Shared workspace column vs CLI-only sidecar: schema 12 was chosen so Runtime and public browsing can use the same attribution. Cost is an explicit verified-backup migration and coordinated client upgrade. A CLI-only mapping would not meet shared-client attribution. Old rows stay unclassified; resume preserves identity; forks belong to destination workspace.
- Shared model controller vs duplicated CLI state machine: a neutral controller keeps revision/admission, synchronous and asynchronous hosts, close cancellation and failed projection semantics in Runtime. Core supplies only model preparation/application. RuntimeService retains transport idempotency and complete `activeTurns + turnJobs` settlement checks.
- Optional `thread.browse` vs adding fields to frozen summaries: a separate Protocol 1.6 method preserves old payload validation. Older protocols reject the new method; Node provides a public helper.
- Read-only ownership inspection vs claim acquisition: advisory inspection reads only existing sidecar records, never reaps/claims. Dead, alive and unknown identity cases are tested. Writable resume always uses existing atomic claim acquisition after selection.

No Core imports/types were introduced into Runtime. No duplicated scheduler state machine or CLI-specific conversation database was introduced. No unused public flexibility or dead code was found. Explicit config selection, launch overrides, Skills/instructions from execution cwd and schedule authority/revision checks stay in Core.

## Validation evidence

- Node 24.21.0, pnpm 11.24.0 on macOS ARM64; clean baseline typecheck passed.
- Workspace package unit suites passed by package. The first aggregate run exposed three old tests assuming global listing; after updating those fixtures to explicit global scope, Core completed 2,212 tests (2,207 passed, five existing skips). Other package suites had zero failures. Subsequent focused ChatGPT/cancellation/controller tests: 28 passed.
- Full Core E2E: 108/108 passed, including four new real CLI scenarios. The first run exposed an ownership fixture's unstamped manually created conversation; the corrected fixture now identifies its workspace.
- Real CLI scenarios: A/B shared-library last selection with B closed last; unclassified exclusion and subdirectory identity; a real peer-process lease with read-only hash/mtime checks and post-release resume; live basic-REPL endpoint/model/key reload and invalid/deleted-file recovery in the same session; model-created schedule plus actual daemon execution retaining the selected config despite a conflicting task config.
- Typecheck (including Core UI), ESLint, changed-file formatting, source-control-character check and `git diff --check` passed.
- Full workspace build, final Core build, isolated compiled `agent health` lazy-loader smoke and published tarball audit passed.
- Changeset status: Core/Runtime/Protocol/client-node minor; dependent packages receive the existing automatic patch propagation. No version files or release were published.
- GitNexus upstream impact identified ThreadStore/RuntimeService as critical shared surfaces; refreshed graph and change analysis were used alongside direct source review, especially for dynamic UI callbacks. An isolated temporary Git index included all 20 new files without modifying the real index: final analysis covered 58 files, 441 symbols and 56 affected processes (critical shared-surface risk).

## Coverage limits

Native Windows/Linux, Node 22, a packaged Desktop application and the live ChatGPT service were not run here. The test suites exercise local fixtures; platform CI remains required. Desktop must update its bundled Runtime before sharing a schema-12 library. This repository provides the shared browse contract; Desktop UI adoption belongs to its repository.

Security checks covered bounded metadata/projections, parameterized persistence, non-mutating browsing, sanitized reload failures, source pinning, stale commits, ownership CAS and cancellation. No deployment, signing/payment, archive extraction, public multi-tenant auth or dependency changes were in scope. Existing cursor regex and new string length gates were checked with invalid/oversized inputs; no new policy/content regex was added.

## Six-axis scorecard

This is the benchmark-code-review skill's local engineering rubric, not an external certification.

| Axis | Score | Evidence/limit |
| --- | --- | --- |
| Correctness | 9 | Critical failure/concurrency regressions fixed and reproduced; no open findings |
| Design / Architecture | 9 | Shared neutral contracts and lifecycle ownership, evaluated alternatives |
| Testing | 8 | Unit and real CLI coverage; native platform/Node22/Desktop/live-provider validation outstanding |
| Operability | 8 | Recovery, diagnostics and verified migration; Desktop coordinated rollout still external |
| Docs / Contract | 9 | User guide, migration warning, frozen legacy contracts and optional public client API |
| Complexity / Maintainability | 9 | Reused loaders/controller/scheduler ownership, focused new modules, no added dependencies |

Raw aggregate: 8.7/10, final 8.7/B+ (provisional). No blocker cap applies. Merge disposition: Not assessed pending platform CI; no unresolved local findings or unaccepted Medium defects.
