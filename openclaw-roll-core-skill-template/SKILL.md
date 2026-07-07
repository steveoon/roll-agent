---
name: roll-core
description: >-
  Operates registered MCP agents through the stable `roll` CLI surface: inspects lifecycle and env status, discovers tools with `roll agent tools`, invokes tools with `roll run --json`, preserves agent-scoped routing keys such as browserInstance, and routes ambiguous intents with `roll ask --json`. Use when an orchestrator or coding agent must operate or troubleshoot registered Roll agents deterministically.
---

# Roll Core

Prefer deterministic execution.

- Use `roll run --json` when the target agent and tool are known.
- When passing a structured object, use `roll run <agent> <tool> --input-json '{...}' --json`.
  This is the orchestrator-safe form across Roll versions and shell environments.
- Use `roll skills get <agent-name> --json` to read the currently registered agent skill before relying on
  embedded or remembered instructions.
- Use `roll agent tools <agent-name> --json` when the agent is known but the tool name or `inputSchema` is not.
- Use `roll ask --json` only when intent is known but the target agent/tool is not.
- Do not default to `roll chat`; it is still experimental.
- Do not embed subagent-specific tool contracts into this shared Roll skill. Read the target subagent's own `SKILL.md` / manifest / reference docs when you need tool-level semantics.

## Orchestrator Quick Path

Use this minimal loop before loading long references:

```bash
roll skills list --json
roll skills get <agent-name> --json
roll agent tools <agent-name> --json
roll run <agent-name> <tool-name> --input-json '{...}' --json
```

Deepen only when needed:

| Need | Next command |
| --- | --- |
| Stable refs, routing keys, browser workflow rules, or subagent recovery docs | `roll skills get <agent-name> --include-references --json` |
| Fleet-level diagnostics | `roll doctor --json` |
| Per-agent runtime ownership, env labels, or human-readable drift details | `roll agent info <agent-name>` |
| Config field meaning or setup guidance | `roll config explain <path>` |

Machine-readable boundaries:

| Parse stdout as JSON | Treat as human-readable text |
| --- | --- |
| `roll skills list --json` | `roll agent info <agent-name>` |
| `roll skills get <agent-name> --json` | `roll config explain [path]` |
| `roll skills get <agent-name> --include-references --json` | `roll config setup ...` |
| `roll agent list --json` |  |
| `roll agent tools <agent-name> --json` |  |
| `roll agent health --json` |  |
| `roll doctor --json` |  |
| `roll run ... --json` / `roll run --batch-* --json` |  |

## Startup Gate

When the target agent's runtime ownership is unclear, inspect it first:

```bash
roll agent info <agent-name>
```

- If the agent is a persistent service (`core-managed` / `external-managed`), run `roll agent health --json` before tool calls.
- If that agent is unhealthy and Roll owns its lifecycle, run `roll agent start <agent-name>`.
- If the agent is `stdio + on-demand`, do not pre-start it.

## Tool Discovery

Read the registered skill first, then inspect the runtime tool schema:

```bash
roll skills get <agent-name> --json
roll agent tools <agent-name> --json
```

Use the skill document for first-pass planning. Add `--include-references` only when the task needs
stable refs, routing keys, browser workflow rules, recovery steps, or deeper business sequencing.
Use `roll agent tools` for exact `inputSchema` / `outputSchema`.

For fleet-level skill discovery:

```bash
roll skills list --json
roll skills path <agent-name>
```

- `roll skills list --json` tells an orchestrator which registered agents expose live skill docs.
- `roll skills get <agent-name> --json` returns `{ name, description, source, content, path? }`.
- `roll skills get <agent-name> --include-references --json` also returns `references[]` with
  `relativePath`, `path`, and `content` for referenced local `references/*` files.
- `roll skills path <agent-name>` is only available when Roll can read a local `SKILL.md`; installed or
  snapshot-only agents may fall back to registry content.

Before first call or after agent updates, discover the exact tool names and `inputSchema`:

```bash
roll agent tools <agent-name>        # table view
roll agent tools <agent-name> --json # machine-readable
```

- Use the table view for manual inspection.
- Use `--json` when another agent or script will parse the result.
- If `roll run <agent> <tool>` prints `Did you mean: ...` in stderr, treat it as a hint and re-run `roll agent tools` instead of guessing from memory.

## Tool Invocation Inputs

Choose the input format by payload shape:

| Payload shape | Preferred command form | Notes |
| --- | --- | --- |
| No input | `roll run <agent> <tool> --json` | Sends `{}`. |
| Simple scalar fields | `roll run <agent> <tool> --key value --json` | Good for one-off manual calls. |
| JSON object / nested object / arrays | `roll run <agent> <tool> --input-json '{...}' --json` | Preferred for orchestrators and chained workflows. |
| Large or generated payload | `roll run <agent> <tool> --input-file ./payload.json --json` | Avoids shell quoting issues. |

Boundary rules:

- Do not pass tool JSON as an unflagged third positional argument in orchestrator code.
- Newer Roll versions may accept positional JSON as a compatibility convenience, but `--input-json` is the stable contract.
- When a tool call fails with symptoms like a missing required field even though the command visibly contains JSON, retry with `--input-json` before debugging the target subagent.
- Keep `--json` for output format separate from `--input-json`; `--json` does not provide tool input.

Windows shell quoting:

- The single-quoted `--input-json '{...}'` form assumes a POSIX shell. In `cmd.exe` single quotes are not quoting characters, and Windows PowerShell 5.1 re-quotes arguments before passing them to native executables — both mangle inline JSON.
- On Windows (or in cross-platform orchestration code), prefer `--input-file ./payload.json`; it avoids shell quoting entirely and is the most portable form.
- If inline JSON is unavoidable: PowerShell 7.3+ passes single-quoted JSON correctly; in `cmd.exe` wrap with double quotes and escape inner quotes as `\"`.

State-setting inputs:

- Some tools model filters, labels, membership, selections, or other target state. Do not assume an array field means "append".
- Read the target agent's `SKILL.md` and `roll agent tools <agent-name> --json` schema to learn whether an array means replace, append, toggle, or clear.
- If a tool exposes fields such as `applyMode`, `patch`, `replace`, or documented clear sentinel values, preserve those exact semantics in generated input.
- Prefer explicit replace-style calls when the desired final state must be deterministic. Use patch-style calls only when unspecified fields should remain unchanged.
- After state-changing calls, verify through the tool output or a read-back tool before reusing refs, indices, or downstream artifacts that may have become stale.

## Agent-Scoped Routing Keys

Some persistent agents expose a routing key that selects an isolated runtime, profile, tenant, workspace, or account. Treat that key as part of the workflow identity, not as an optional convenience.

Pattern:

```text
orchestrator task/thread
  -> choose one explicit routing key
  -> pass the same key in every target-agent tool input
  -> never pass refs, prepared artifacts, or page ids across different routing keys
```

Rules:

- Read the target agent's `SKILL.md` for the exact routing field name and fallback behavior.
- If a target browser agent exposes `browserInstance`, include it in every browser-runtime tool call for that browser workflow, including no-input tools via `--input-json`.
- If the target agent documents a helper or judge tool as global/no-runtime, follow that tool's exact schema and do not force `browserInstance` into the input. Keep the prepared artifact tied to the workflow that created it, then resume browser-runtime calls with the original routing key.
- Do not rely on a global default when operating multiple accounts concurrently; defaults are only safe for single-account or deliberately pinned deployments.
- Keep routing keys out of unstructured prompts. Put them in the JSON input object passed to `roll run`.
- Treat agent-returned refs, page ids, prepared reply ids, and session state as scoped to the routing key that produced them.

Example browser workflow:

```bash
roll run browser-use-agent open_platform \
  --input-json '{"browserInstance":"boss-a","platform":"zhipin"}' --json

roll run browser-use-agent zhipin_read_messages \
  --input-json '{"browserInstance":"boss-a","onlyUnread":true,"limit":5}' --json
```

For multi-worker orchestration, assign one worker to one routing key:

```text
worker A -> browserInstance=boss-a -> all browser-runtime browser-use calls include boss-a
worker B -> browserInstance=boss-b -> all browser-runtime browser-use calls include boss-b
```

Same-routing-key calls are serialized server-side by browser agents: parallel tool calls against one
`browserInstance` queue up and do not speed anything up, while queue time still counts against each
call's request timeout. Different routing keys run in parallel. If a call times out, do not blindly
retry a side-effect tool; first verify with a read-only tool (for example `browser_status` or the
agent's documented read tools) whether the original operation already landed. A request cancelled
while queued returns `cancelled_while_queued` and is guaranteed not to have executed.

## Prepared Artifacts And Variant Decisions

Some agents hide sensitive send authorization inside an opaque prepared artifact and may return
neutral alternatives that require a separate decision before sending.

Rules:

- Prefer the opaque sender contract documented by the target agent, such as `preparedReplyId`, over
  passing low-level envelopes or raw generated text through the orchestrator.
- If a tool returns neutral alternatives such as `replyVariantSelection`, do not send immediately
  unless the target agent documents a compatible default. Run the documented judge/decision helper or
  choose an option explicitly, then pass the resulting decision object to the sender tool.
- Do not infer hidden labels behind neutral options. Treat `option_1` / `option_2` style labels as the
  only orchestrator-visible choices.
- Retry confirmation-gated sends with the same routing key, prepared artifact, chosen option, reason,
  and approval object. Do not reuse an approval after changing the prepared artifact or decision.
- If a generator agent still returns a lower-level envelope, use it only when the target agent's own
  `SKILL.md` says that is the intended sender contract. For browser-mediated sends, prefer the
  browser agent's prepared-send flow so sensitive envelopes stay inside that agent.

## Browser Runtime Lifecycle

Use lifecycle commands at the correct layer:

| Need | Command | Effect |
| --- | --- | --- |
| Close one or more browser runtimes | `roll browser stop <browserInstance...>` | Closes only the selected browser runtime(s); keeps `browser-use-agent` running; profile/session data stays on disk; later tool calls may lazy-start the runtime. |
| Close all started browser runtimes | `roll browser stop --all` | Closes all currently started browser runtimes managed by the current agent; keeps the service process running. |
| Stop the browser agent service | `roll agent stop browser-use-agent` | Stops the whole service process; browser tools are unavailable until `roll agent start browser-use-agent`. |
| Delete browser profile/session data | `roll browser clear-data [browserInstance] --yes` | Deletes declared browser data paths. Run without `--yes` first to inspect the deletion plan. |

Boundary rules:

- Prefer `roll browser stop` when only a browser window/runtime is stale, stuck, or no longer needed.
- Use `roll agent stop browser-use-agent` only for service-process lifecycle, not for routine window cleanup.
- Do not scan or kill system Chrome processes from orchestration code. Roll lifecycle commands operate on runtimes declared in config and owned by the current agent.
- For browser agents with external sessions, runtime stop may mean disconnecting Roll from the browser rather than killing an external browser process. Read the target agent's `SKILL.md` for exact mode semantics.
- Before deleting profile/session data, stop the target runtime or use the agent's documented force option only when intentional.

## Browser Page Recovery

When a browser page is stale but the browser runtime and agent service are still healthy, prefer a
target-agent-provided page recovery tool before closing the runtime.

Recovery priority:

1. Read the target agent's current `SKILL.md` / references with `roll skills get <agent-name> --include-references --json`.
2. If the target agent documents a page reload, recovery, or semantic section opener with a reload option, use that documented tool first.
3. After any reload/recovery action, discard all page snapshot refs and business refs returned before the reload; run the relevant snapshot or reader tool again.
4. If page-level recovery fails or the runtime itself is stuck, then use `roll browser stop <browserInstance>` and reopen the workflow with the same routing key.

Boundary rules:

- Do not invent a reload URL or hardcode a platform-internal route. Use the target agent's documented recovery tool.
- Do not assume reload frees renderer process memory. It refreshes page/document state; runtime/process cleanup remains `roll browser stop`.
- Do not use `roll agent stop <agent-name>` for page state recovery unless the service process itself is unhealthy.
- Keep exact recovery tool names, approval fields, and output flags in the target agent's own `SKILL.md`.

## Batch Tool Calls

Use batch mode when an orchestrator already knows a sequence of independent or serial `roll run`
calls and wants one CLI process:

```bash
printf '%s\n' '[{"agent":"browser-use-agent","tool":"browser_status","input":{}}]' \
  | roll run --batch-stdin --json
```

Each item is:

```json
{ "agent": "<agent-name>", "tool": "<tool-name>", "input": {}, "label": "optional" }
```

Rules:

- Do not pass positional `agent/tool` together with `--batch-json`, `--batch-file`, or `--batch-stdin`.
- `input` must be a JSON object; omit it only when the tool accepts `{}`.
- If a target agent requires an account/profile routing key, include it in every batch item `input`; batch mode does not inherit input fields between items.
- Use `--bail` when later steps should stop after the first failed item.
- Parse the stdout JSON as an array of per-item results. Branch on each item's `ok` field, not only
  the process exit code.
- Batch mode is sequential execution in one CLI process, not a workflow engine.
- Batch mode does not pass one item's output into another item, does not provide result references,
  and does not expose streaming progress between items.
- For dependent chains, split the work into explicit phases and let the orchestrator parse and
  filter each phase before constructing the next batch.

## Navigation Tool Choice

When the task involves switching pages, tabs, or in-app sections, choose the tool by semantic level instead of defaulting to raw URL navigation.

Priority:

1. Prefer target-agent-specific navigation tools that express the user intent directly, such as `*_open_*_page()`, `*_switch_*()`, or other section-level tools documented by the target subagent.
2. If the target page is already open and identifiable, prefer `list_pages` + `select_page` over re-navigation.
3. Use generic URL navigation tools such as `navigate_active_tab(url)` only when no higher-level navigation tool exists for that subagent/workflow.

Practical rule:

- Do not guess internal site/app URLs when the target subagent already exposes a semantic navigation tool.
- Read the target subagent's own `SKILL.md` first for these higher-level navigation affordances.
- In this repo, `browser-use-agent` documents platform-specific section openers in its own `SKILL.md`; treat those as the source of truth instead of hardcoding site routes into the shared Roll skill.

## UI Observation And Ref Actions

When a browser-like target agent exposes page snapshots and element refs, treat them as an
observe/action/verify loop rather than as a one-shot command.

Priority:

1. Prefer domain-specific tools that express the user intent directly, such as `send`, `open`,
   `filter`, `select`, or `exchange` tools documented by the target subagent.
2. Use generic snapshot/ref tools for unmodeled accessible controls when the target subagent
   documents them.
3. Use raw navigation, attach, evaluate, diagnostics, or selector-like tools only when the target
   subagent explicitly recommends them for that workflow.

Generic flow:

```text
roll skills get <agent-name> --include-references --json
  -> roll agent tools <agent-name> --json
  -> observe current page through the target agent's snapshot tool
  -> choose only a ref emitted by that snapshot
  -> run the target agent's ref action tool
  -> verify with a fresh snapshot or a domain-specific read tool
```

Rules:

- Do not invent element refs or reuse refs across page navigations, reloads, filtering, or modal changes.
- If multiple browser pages are open, pass the explicit page identity returned by the target agent's page-listing tool.
- If a browser agent returns `frameId` on an element ref, treat it as internal ref metadata owned by
  that browser agent. Continue passing the emitted ref handle; do not synthesize or edit frame IDs in
  the orchestrator.
- Treat element refs as current-snapshot handles, not durable business IDs.
- If the target agent also exposes business refs, keep each ref family scoped to the tools that emitted it.
- Keep exact tool names, schemas, ref formats, and action-policy confirmation details in the target subagent's own
  `SKILL.md` / references. This shared Roll skill only defines the orchestration pattern.

## Diagnostics & Maintenance

- `roll doctor --json` — system health check, including runtime env drift summary for registered agents.
- `roll doctor --fix-plan --json` — include safe remediation hints without mutating local state.
- `roll doctor --fix --json` — apply safe fixes only: config migration, `agents.dataDir` creation, and
  orphan core-managed runtime metadata cleanup.
- `roll agent health --json` — per-agent runtime check. In v0.6.7+, persistent agents can also report
  sidecar issues such as version mismatch, orphan metadata, or PID mismatch before endpoint probing.
- `roll update --check` — check available updates for roll-core and all registered agents without applying.
- `roll update` — apply all available updates (lifecycle varies by source type).
- `roll config explain [path]` — document a config key (purpose, defaults, examples); omit `path` to list common entries.
- `roll config setup [llm|install|agent] [agent-name]` — interactive config wizard (TTY required; cancel → non-zero exit).
- `roll config migrate` — run when doctor or update reports `needs-migration`.

Decision flow:

1. Unknown system state or unexpected tool failure -> run `roll doctor --json`.
2. `doctor` returns `warn` / `fail` and a fix may exist -> run `roll doctor --fix-plan --json`.
3. The proposed fix is within the safe-fix boundary -> run `roll doctor --fix --json`.
4. A persistent agent still fails -> run `roll agent info <agent-name>` and
   `roll agent health --json`; restart only when Roll owns that agent lifecycle.

For output formats, env drift labels, update lifecycle details, and follow-up actions, see [references/workflows.md](./references/workflows.md).

## Output Handling

- Parse JSON from stdout.
- Treat stderr as diagnostics such as `Did you mean: ...`, `cause: ...`, and human-readable `needs_input` sections; do not parse stderr as the result payload.
- Treat non-zero exit codes as failures or gated states.
- For `roll ask --json`, handle `success`, `needs_input`, `needs_confirmation`, and `failed`.
- When `roll ask --json` returns `needs_input`, resolve both `validationIssues` and `runtimeIssues` before retrying with `roll run`.
- Treat `roll ask` as single-shot. For multi-step workflows, chain explicit `roll run` calls.

## References

- For first-time machine setup, `roll config setup/explain`, config migration, npm install network config, and **the difference between `roll agent add` (local source) vs `roll agent install` (published package)**, read [references/setup.md](./references/setup.md).
- For multi-step Roll CLI recipes and troubleshooting sequences, read [references/workflows.md](./references/workflows.md).
- For common Roll-layer failures and recovery paths, read [references/errors.md](./references/errors.md).
- For cross-agent sequencing, verification patterns, and shared orchestration pitfalls, read [references/cross-agent-orchestration.md](./references/cross-agent-orchestration.md).
- For tool input/output details, env declarations, and capability boundaries, read the target subagent's own `SKILL.md` or runtime metadata.
