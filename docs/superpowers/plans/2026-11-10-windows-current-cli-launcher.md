# Windows current CLI launcher implementation plan

> **For agentic workers:** Execute this plan inline, task by task. The applicable Desktop AGENTS.md requires the current agent to perform Desktop work without subagents.

**Goal:** Nested `roll` commands use the current Core and Node on Windows, including extended paths, while preserving arguments, raw standard streams and existing process ownership.

**Architecture:** Core owns a conservative CMD path conversion and an exceptional native launch bridge. The bridge uses the existing Windows PowerShell host to call `CreateProcessW` with an explicit application name and inherited standard handles; it adds no job, detached process or process-group ownership. Desktop retains its namespaced native launch. Runtime and Protocol contracts remain unchanged.

**Tech Stack:** TypeScript with Node type stripping, node:test, Windows PowerShell 5.1 and framework C# P/Invoke, existing Electron production packaging and controlled loopback model fixtures. No new package dependencies.

**Spec:** User-approved design and three implementation constraints in this chat, reproduced below.

## Global constraints

- Convert only demonstrably equivalent ordinary drive/UNC paths. Preserve namespace-specific meaning, trailing spaces/dots and device/volume paths by using the bridge. Do not rewrite a whole command or decide by length alone.
- Verify empty arguments, embedded/nested quotes, trailing backslashes, Unicode, stdin/stdout/stderr bytes and exit codes before integrating the bridge into Core.
- PowerShell must not pipe, decode, encode or buffer the child's standard streams. Recover the raw argument suffix from its native command line rather than trusting `$args` or `-File … %*` conversion.
- Keep the existing process tree, console and Job Object membership. Do not copy Desktop's job ownership or kill unrelated processes. Verify cancellation and app shutdown.
- Use real packaged production Desktop applications with isolated HOME/userData/config/history, controlled loopback models and system-only PATH. Exercise a tool that invokes `roll` on Windows ARM64 and x64; retain macOS regression.
- Preserve all user installations, data, old artifacts and pre-existing worktree changes. No push, merge or release is authorized.
- Repository toolchain: Node >=22.13.0 and pnpm 11.24.0. Core's published Node floor stays >=22.6.0.

## Task 1: independently validate the Windows adapter

**Files:** Create `packages/core/src/cli/utils/current-cli-windows.ts` and `current-cli-windows.test.ts`.

**Interfaces:** `cmdExecutablePath(path: string): string | undefined` returns an equivalent CMD executable token or selects the bridge. `renderWindowsCliFiles(command: readonly string[], systemRoot: string): Readonly<Record<string, string>>` returns `roll.cmd` and, when needed, its private helper. Both are internal Core utilities.

- [x] Test the conversion table: `\\?\C:\app\node.exe → C:\app\node.exe`; `\\?\UNC\host\share\node.exe → \\host\share\node.exe`; preserve volume, device, relative and noncanonical paths through the bridge.
- [x] Implement the conservative conversion and pure rendering. Fixed launch values travel as encoded JSON data. The helper reads the raw suffix following a unique marker from `GetCommandLineW`, then calls `CreateProcessW` with the fixed prefix quoted using Windows native argument rules.
- [x] Run actual Windows ARM64 and x64 Node tests, with a copied Node at >260 characters. Assert an adversarial argument vector and exact binary stream equality, plus nonzero exit status. Keep the helper's stdin/stdout/stderr directly inherited and its handle list restricted to standard streams.

```js
const argumentsToForward = ["", "hello world", "中文", 'a"b', 'a\\"b', "tail\\", "two\\\\", "&|<>^%!", "--flag=value"];
const bytes = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 256));
// Child emits its argv to an owned file, copies bytes to stdout and stderr, exits 7.
// Compare every value and every byte; a generated-script text assertion is insufficient.
```

## Task 2: integrate with current CLI scope

**Files:** Modify `current-cli-shim.ts`, extend `current-cli-shim.test.ts`, add a Core patch changeset.

**Consumes:** Task 1's file renderer. **Produces:** existing `installCurrentCliShim` API and environment/disposal behavior, unchanged.

- [x] Use `renderWindowsCliFiles(command, systemRoot)` only on Windows and write every returned helper into the existing private temporary directory. POSIX rendering remains unchanged.
- [x] Extend tests for ordinary namespaced executables, bridge files, non-LIFO cleanup, relative preloads, process environment and inspector filtering. Run existing Chat/server wiring tests.
- [x] Run Core typecheck, lint, source tests, build and the built `agent health` lazy-loading check; run relevant runtime shell cancellation tests without changing Runtime.

```sh
node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/utils/current-cli-{windows,shim}.test.ts
pnpm --filter @roll-agent/core typecheck
pnpm --filter @roll-agent/core build
node packages/core/dist/cli/index.js agent health
```

## Task 3: validate production integration and lifecycle

**Files:** Add a bounded validation harness/report under `scripts/` and `docs/reports/`; use separate ignored development package workspaces outside real installations.

- [x] Copy the tested Core dist into separate development runtime bundles with explicit file hashes and NOT-PUBLISHED provenance; preserve official manifests and original bundles.
- [x] Adapt the production packaged fixture to request a shell tool that invokes `roll agent list --json`, checks its structured output and records its current CLI path, not just a version banner. Verify the local model receives the successful tool result.
- [x] Run Windows ARM64 and x64 packaged executables (state explicitly if x64 runs under Windows ARM64 emulation), and macOS Apple Silicon packaged application.
- [x] Exercise tool cancellation, application shutdown, ordinary console cancellation, helper teardown and an unrelated sentinel process. Verify owned children exit and the sentinel survives.
- [x] Run final graph change analysis and self-review; record exact commands, architectures, artifact hashes, limitations and remaining work. Do not report unexecuted coverage as passed.

## Pre-edit evidence

At base `1ab21b98`, full GitNexus refresh resolved the earlier incremental symbol omission. `installCurrentCliShim` has one direct caller (`createChatCliScope`), four upstream symbols and three affected entry flows (Chat, server, runtime serve), rated HIGH. `renderWindowsShim` has one direct caller and LOW local risk. The repository was clean and Core baseline typecheck passed. No Runtime/Core boundary change is planned.

## Outcome

Implemented inline. See `docs/reports/2026-11-10-windows-current-cli-launcher.md` for final acceptance, artifact provenance, x64 emulation scope and the independently reproduced Desktop deep-profile-helper limitation. No remote push, merge or release.
