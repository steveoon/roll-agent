---
name: roll-core
description: Operates registered MCP agents through the stable `roll` CLI surface: inspects lifecycle and env status, discovers tools with `roll agent tools`, invokes tools with `roll run --json`, and routes ambiguous intents with `roll ask --json`. Use when an orchestrator or coding agent must operate or troubleshoot registered Roll agents deterministically.
---

# Roll Core

Prefer deterministic execution.

- Use `roll run --json` when the target agent and tool are known.
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
