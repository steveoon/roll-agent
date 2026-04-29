---
name: roll-core
description: >-
  Operates registered MCP agents through the stable `roll` CLI surface: inspects lifecycle and env status, discovers tools with `roll agent tools`, invokes tools with `roll run --json`, and routes ambiguous intents with `roll ask --json`. Use when an orchestrator or coding agent must operate or troubleshoot registered Roll agents deterministically.
---

# Roll Core

Prefer deterministic execution.

- Use `roll run --json` when the target agent and tool are known.
- When passing a structured object, use `roll run <agent> <tool> --input-json '{...}' --json`.
  This is the orchestrator-safe form across Roll versions and shell environments.
- Use `roll agent tools <agent-name> --json` when the agent is known but the tool name or `inputSchema` is not.
- Use `roll ask --json` only when intent is known but the target agent/tool is not.
- Do not default to `roll chat`; it is still experimental.
- Do not embed subagent-specific tool contracts into this shared Roll skill. Read the target subagent's own `SKILL.md` / manifest / reference docs when you need tool-level semantics.

## Startup Gate

When the target agent's runtime ownership is unclear, inspect it first:

```bash
roll agent info <agent-name>
```

- If the agent is a persistent service (`core-managed` / `external-managed`), run `roll agent health --json` before tool calls.
- If that agent is unhealthy and Roll owns its lifecycle, run `roll agent start <agent-name>`.
- If the agent is `stdio + on-demand`, do not pre-start it.

## Tool Discovery

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

## Diagnostics & Maintenance

- `roll doctor --json` — system health check, including runtime env drift summary for registered agents.
- `roll update --check` — check available updates for roll-core and all registered agents without applying.
- `roll update` — apply all available updates (lifecycle varies by source type).
- `roll config migrate` — run when doctor or update reports `needs-migration`.

For output formats, env drift labels, update lifecycle details, and follow-up actions, see [references/workflows.md](./references/workflows.md).

## Output Handling

- Parse JSON from stdout.
- Treat stderr as diagnostics such as `Did you mean: ...`, `cause: ...`, and human-readable `needs_input` sections; do not parse stderr as the result payload.
- Treat non-zero exit codes as failures or gated states.
- For `roll ask --json`, handle `success`, `needs_input`, `needs_confirmation`, and `failed`.
- When `roll ask --json` returns `needs_input`, resolve both `validationIssues` and `runtimeIssues` before retrying with `roll run`.
- Treat `roll ask` as single-shot. For multi-step workflows, chain explicit `roll run` calls.

## References

- For first-time machine setup, config migration, and **the difference between `roll agent add` (local source) vs `roll agent install` (published package)**, read [references/setup.md](./references/setup.md).
- For multi-step Roll CLI recipes and troubleshooting sequences, read [references/workflows.md](./references/workflows.md).
- For common Roll-layer failures and recovery paths, read [references/errors.md](./references/errors.md).
- For cross-agent sequencing, verification patterns, and shared orchestration pitfalls, read [references/cross-agent-orchestration.md](./references/cross-agent-orchestration.md).
- For tool input/output details, env declarations, and capability boundaries, read the target subagent's own `SKILL.md` or runtime metadata.
