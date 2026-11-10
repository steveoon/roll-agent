# Roll Chat Workspace Experience Implementation Plan

> 2026-11-10 调整：本文保留原实施记录。普通 `roll chat` 的 `/reload` 已移除，当前行为见 [设计](../chat-workspace-experience-design.md)；第三方 Runtime 配置重载接口保留。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give normal CLI chat bound configuration/reload, project-scoped history, and safe cross-client browsing.

**Architecture:** Core resolves configuration/workspace and injects neutral execution inputs. Runtime owns workspace persistence and one model-application coordinator shared with RuntimeService; Protocol exposes an optional browsing contract without altering frozen summaries.

**Tech Stack:** TypeScript ESM, Zod, node:sqlite, node:test, Ink/clack; no new dependencies.

**Spec:** `docs/chat-workspace-experience-design.md`

## Global Constraints

- Node >=22.13.0 for repository development; pnpm 11.24.0.
- No Core dependency from Runtime; no secrets in persisted source/workspace references.
- ThreadStore schema 12 uses existing backed-up explicit migration; never migrate real development-user history.
- `--last` selects the current project's last interactive conversation, never a global fallback.
- Read-only supported old libraries remain readable and unclassified; unknown higher versions fail.
- Preserve CLI confirmation/stdio contracts, launch overrides, and execution-cwd tool/Skills/instruction semantics.
- Run impact before edits and graph change analysis before any commit. Work on `codex/chat-workspace-experience`.

## Task 1: Shared workspace attribution and identity

**Files:** `packages/runtime/src/store/thread-store.ts`, its tests; `packages/runtime/src/engine/conversation-engine.ts`, its tests; create `packages/core/src/runtime-host/workspace-identity.ts` and tests; Core session-ownership capability schema version.

**Interfaces:** `ThreadRecord.workspace?: string`, `CreateThreadInput.workspace?: string`, `ListThreadsOptions.workspace?: string | null` (undefined=all, null=unclassified). Engine option `workspace?: string` stamps creates/forks. `resolveChatWorkspace(cwd?: string): string` canonicalizes nearest Git worktree root, otherwise cwd.

- [x] Add regression tests: two projects share one DB, latest B excluded from A; null selects legacy; forks use destination workspace; supported old read-only DB has no new-column requirement.
- [x] Add schema-12 nullable workspace column and writer/migration guards through existing versioned migration. Preserve immutable attribution on resume.
- [x] Resolve/test Git subdirectory, worktree-file, non-Git directory and symlink identities in Core.
- [x] Run `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/store/thread-store.test.ts packages/runtime/src/engine/conversation-engine.test.ts packages/core/src/runtime-host/workspace-identity.test.ts`.

```ts
const a = store.createThread({ workspace: '/projects/a' });
store.createThread({ workspace: '/projects/b' });
assert.deepEqual(store.listThreads({ origin: 'interactive', workspace: '/projects/a' }).map(t => t.id), [a]);
```

## Task 2: Reusable model-application coordination

**Files:** create `packages/runtime/src/service/model-config-controller.ts` and tests; `packages/runtime/src/service/runtime-service.ts`, tests; Runtime public exports; Core `runtime-host/runtime-model-config.ts` and tests.

**Interfaces:** export `ModelConfigController` and existing `RuntimeModelConfigHost` (permit sync or async host reload). Controller exposes `getStatus()`, `reload()`, `tryApply()`, `assertReady()`, `close()`; constructor takes host, initial reasoning, `isBusy`, and optional `onApplied`. It keeps revisions, active identity, pending/failed barriers and serializes async reloads. RuntimeService retains request-id idempotency/transport error mapping and calls controller after successful turn-job settlement.

- [x] Reproduce pending-turn/approval, two reload requests, invalid source, async stale completion and failed turn-projection barriers.
- [x] Extract coordinator without weakening RuntimeService's `activeTurns` + `turnJobs` close barrier. Failed projection remains busy; no retries admit a turn.
- [x] Preserve synchronous RuntimeService status behavior and reasoning subscriptions/capability truthfulness. CLI async preparation commits only behind the same barrier.
- [x] Run focused controller, RuntimeService, reasoning and Core reload-host tests.

```ts
let busy = true;
const control = new ModelConfigController({ host, isBusy: () => busy });
assert.equal(control.reload().status, 'pending');
assert.throws(() => control.assertReady());
busy = false;
control.tryApply();
assert.equal(control.getStatus().status, 'applied');
```

## Task 3: Safe shared browsing contract

**Files:** Runtime ownership/session-claims and ThreadStore tests; Protocol index/tests; RuntimeService/server adapter/tests; client-node client/tests.

**Interfaces:** `ThreadStore.inspectSessionOccupancy(id)` returns bounded safe status/owner metadata without acquiring/reaping claims. Optional 1.6 `thread.browse({workspace?,cursor?,limit})` returns `{items:[{thread, workspace: string|null, occupancy}],nextCursor}`. Existing `thread.list`/summary payloads stay identical. Public Node client helper follows existing method conventions.

- [x] Test readonly browsing while peer owns a thread, dead/unknown process identity, missing sidecar, corrupt/unreadable sidecar, and final writable claim race.
- [x] Implement read-only snapshot/listing without migration, claims creation or retention. Validate bounded schemas and legacy method compatibility.
- [x] Run Protocol/client-node/Runtime server/service and ownership tests.

## Task 4: CLI configuration, reload and history UI

**Files:** `packages/core/src/cli/commands/chat.ts`; new focused `cli/chat` configuration/history controls with tests; Ink app/run-ink-repl/commands and tests; Core engine-factory tests.

**Interfaces:** normal CLI accepts `--config`, `--config-workspace`, `--all-projects`, `--view`; Repl/Ink receive shared configuration control and scoped history source. Slash actions `/reload`, `/status`, `/resume all`, `/view ID` work in both surfaces.

- [x] Test config flag validation, discovered-source pinning/deletion, cwd separation, schedule inheritance and launch overrides.
- [x] Inject configContext and workspace in normal/server factories. Reuse selected startup source for reload and schedule binding; no process-global chdir.
- [x] Wire controller through complete send/preparation/settlement and compaction lifecycle; update actual model/status/catalog and ChatGPT state consistently after successful reload. Preserve context/history/tool processes.
- [x] Scope `--last`, `--list` and picker by workspace; explicit all-projects view includes unclassified. Add read-only view and occupancy labels, retaining atomic resume checks and current session on failed switch.
- [x] Run Core unit tests for chat, Ink and host integration.

## Task 5: Executable acceptance, docs and review

**Files:** add Core `smoke-chat-workspace.e2e.ts` and expand config/reload E2E; user docs and Changeset for affected public packages.

- [x] Use temporary HOME/config/store and traced local endpoint to prove A/B `--last`, invalid source recovery, endpoint/model reload and schedule binding actual execution.
- [x] Hold a separate process's ownership claim; prove list/view succeeds without writes and resume refuses, then succeeds after release.
- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, affected builds and formatting/source-control checks. Published lazy-loader smoke must resolve `.js` files.
- [x] Review architecture, async admission/settlement, migration rollback, side effects and protocol compatibility; fix findings and rerun relevant regressions.
- [x] Update task checkboxes with actual evidence and limitations. Run GitNexus detect_changes for all changes, inspect unresolved/truncated results. Report branch and working-tree state; submission/push is a separate user action.

## Completion evidence

Implemented on `codex/chat-workspace-experience`; no commit/push. See `docs/reports/2026-11-09-chat-workspace-review.md` for executed checks, fixed review findings and native-platform/packaged-Desktop coverage limits. The canonical tracked design is `docs/chat-workspace-experience-design.md`; this repository ignores `docs/superpowers/`, so the tracked plan is `docs/plans/2026-11-09-chat-workspace-experience.md`.

## Follow-up P2 fixes

- [x] Preserve the pinned source/resource workspace across chat onboarding detection, LLM writes, Agent registry/network and start environment, and post-wizard binding.
- [x] Keep unavailable reload outside Runtime application failure/admission transitions; retain active identity, revision, manual model changes and future user turns.
- [x] Add red/green regressions for source selection, configured sources, Agent paths/environment, selected-source deletion and unchanged admission.
- [x] Execute real CLI onboarding and unbound subscription conversations with isolated configuration and local model endpoints; preserve conflicting files and conversation history.
- [x] Run Core unit tests, full E2E, workspace typecheck/lint, build/compiled CLI smoke, graph impact/change analysis and follow-up review; record platform/UI/live-service coverage limits in the review report.
