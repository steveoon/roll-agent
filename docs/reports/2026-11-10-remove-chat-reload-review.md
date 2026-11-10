# Remove ordinary Roll Chat reload — review

## Review scope

Working tree in `/Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent`, branch `dev`, HEAD `ef1b8f5e4e6fe21796e9827c7b090860b28d9bad`. Review covers this removal relative to the captured pre-task working tree, preserving the existing grouped-history work. No commit, push, package version change, user configuration/history migration or installed CLI update.

Included: CLI command wiring, Ink/basic REPL, CLI-only reload adapter and preparation helper, regression tests, current docs and a Core-only Changeset. Excluded from modification: Runtime, Protocol, client-node, Companion, Relay and shared Runtime model-config/host adapters. The legacy server body was compared byte-for-byte with its pre-task version.

## Understanding

The ordinary chat `/reload` applied only part of the configuration, while maintaining a full model-config admission lifecycle. The feature and CLI-specific state are removed. `/status` reads the live selected model and startup source without a reload controller. `/model`, effort, Fast, authentication recovery, turn execution and history retain their responsibilities. File edits take effect after restarting and resuming. External Runtime reload and per-thread model contracts remain available.

## Prior issues → status

- Partial reload UX: **fixed**, command removed from both REPL paths and command discovery. Unknown `/reload` remains local rather than entering the conversation/model.
- Reload failure blocking ordinary chat: **fixed**, adapter, admission callbacks, reload-only guards/subscriptions and dedicated ChatGPT reload preparation removed.
- Preserve third-party capabilities: **verified**, backend diffs match the pre-task snapshot and real Runtime/legacy-server reload executions pass.

## Scorecard

| Axis | Score | Evidence / reason |
| --- | --- | --- |
| Correctness | 9/10 | Actual CLI requests prove startup stability and restart/resume; third-party stdio reload and selection pass. Native Windows/Linux not run locally. |
| Design / Architecture | 9/10 | CLI concern removed without changing shared host/service contracts. A read-only callback replaces controller coupling. |
| Testing | 9/10 | 178 focused regressions, 145 API/host/client checks, 14 real E2E cases and built Ink PTY. Hosted CI remains pending. |
| Operability | 9/10 | Explicit restart/resume guidance; malformed/deleted source cannot block an already-open chat; clean terminal restoration. |
| Docs / Contract | 9/10 | Current guides/design match the behavior; historical plan annotated; CLI removal marked Core major. |
| Complexity / Maintainability | 9/10 | Removed controller, reload preparation and now-unused lifecycle hooks; retained existing Fast revision/rebase mechanisms. |

**Overall: provisional A- (9.0/10)**. Raw equal-weight aggregate 9.0; no severity cap. Local six-axis rubric, not an official Google score.

**Merge disposition: Not assessed** — no unresolved findings from this local review; Windows/Linux hosted CI and repository-wide release gates have not run for this uncommitted tree.

## Findings

No unresolved Critical, High, Medium or Low findings in this removal.

## Design notes

- Chosen: remove the CLI adapter, keep shared Runtime ModelConfigController. Alternative: delete the shared controller with the command. Rejected because Runtime/legacy server consumers still need it and real external API behavior must remain compatible.
- Chosen: read-only `getStatus` callback from the CLI host. Alternative: retain a reduced configuration-controller abstraction. The callback needs no subscription, revision, apply function or busy counter and reports the actual current selection.
- Chosen: keep existing Fast last-request-wins revision and synchronous preference rebase during model commit. Reload-specific guards are removed. A guard based on the entire selection object would incorrectly reject an overlapping Fast change that the existing model-switch resolver already rebases; no such new guard is retained. Concurrency tests cover both completion orders.
- Essential complexity: startup config binding, account preparation, model capability validation, engine busy barriers, scheduler context, history ownership. These remain intact. Accidental complexity removed: CLI reload-only lifecycle/admission and duplicate model-config status propagation.
- Security/trust: status emits only project/source/Provider/model, no credentials. External RPC authorization, schemas and storage code are unchanged. Real tests use isolated homes/history and local fixture endpoints.
- Regex/string gates: basic REPL reuses existing `isSlashCommandShaped` after known commands/skills. Existing command/absolute-path tests plus 8 executed boundary probes passed. There is no new policy/redaction pattern.

## Verification performed

- Focused Core formatter/picker/App/chat/model/Fast/ChatGPT checks: **178/178**. Includes unknown reload staying local and the next message still usable, dynamic status, model-switch errors, user-input/preparation and grouped-history regressions.
- Runtime model-config controller/config binding/Node Client: **61/61**. Runtime service/Protocol/thread-model host: **84/84**.
- Real workspace CLI E2E: **10/10**, including legacy `chat --server` reload to an actual updated model request. Config onboarding/unbound chat: **2/2**. Runtime binding/reload/daemon E2E: **2/2**.
- Changed model/key/endpoint, malformed and deleted source: current chat continued on the original model/key/endpoint; slash commands made no model request. After source repair and `--last`, the new model/key/endpoint executed and prior context survived.
- Third-party `runtime serve --stdio`: per-thread model isolation, MCP Sampling, reload, detach/reopen and CLI continuation. Config reload waits for the active turn and retains bound source semantics.
- Built `dist` Ink under a real isolated PTY: `/model` switches successfully, `/status` follows the selected model, `/reload` is locally unknown, invalid config does not replace the active selection, clean exit0 with terminal modes restored.
- Core typecheck, focused ESLint, affected Prettier, Core build, built lazy-loaded `agent health`, and `git diff --check` passed.
- Backend diff SHA256 before/after: `9258f815e5a4b7b8c2c199d345812b0ef037bdfc6cdfd07c0ebb578026410302`. Existing work outside intended overlap compared unchanged. Legacy `runServer` body unchanged.
- GitNexus pre-edit impact and final `detect_changes --scope all` run. Final payload lists all 28 mapped symbols and 1,078 flows without partial/truncated flags. CRITICAL is the cumulative central-chat/ThreadStore fan-out warning, not a confirmed defect. Symbol resolution was overbroad/missed the CLI adapter; direct source consumers, the removal-only diff and executed entry points were reviewed to resolve that limitation. Untracked files were reviewed separately.
- Changeset status: this removal marks only Core major (published CLI command removal). The existing grouped-history Changeset independently marks Runtime minor. Combined preview is Core 2.0.0 / Runtime 1.7.0; no manifest versions were changed or published.

## Unverified coverage

- Applicable checks not run: native Windows/Linux and hosted CI, full monorepo test/release gates and packed tarball audit. Local environment is macOS arm64, Node 24.21.0, pnpm 11.24.0.
- Untraced integration: no live Desktop/Companion renderer acceptance or real provider credentials used. Shared contracts are unchanged; RPC/host and local-provider execution cover the affected boundary, not each external app UI.
- Non-applicable major sections: no schema migration, new DB mutation, public wire change, provider request adaptation, signing/payment or deployment change in this removal.

## What looks strong

- Shared APIs are protected by both byte-identical backend scope and actual client calls, rather than type checks alone.
- Current-chat continuity and restart/resume history are checked against actual model requests.
- UI/backend reload responsibilities are separated without a new generic configuration framework.

## Residual risks / follow-ups

Run Windows/Linux CI and normal release gates when preparing the PR. Publishing must account for the Core CLI breaking-change release note; the currently installed release is unchanged.
