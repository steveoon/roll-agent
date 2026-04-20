---
name: roll-core
description: Use the `roll` CLI to inspect registered MCP agents, verify lifecycle and env status, invoke tools through `roll run --json`, and route unclear intents through `roll ask --json`. Trigger when an orchestrator or coding agent should operate or troubleshoot registered Roll agents through the stable Roll CLI surface.
---

# Roll Core

Prefer deterministic execution.

- Use `roll run --json` when the target agent and tool are known.
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

Before calling a tool, discover its exact name and input schema:

```bash
roll agent tools <agent-name>        # table view
roll agent tools <agent-name> --json # machine-readable
```

If `roll run <agent> <tool>` is invoked with a misspelled tool name, Roll returns a fuzzy-matched "Did you mean: ..." suggestion and a pointer to `roll agent tools`. Prefer calling this discovery command instead of guessing from memory.

## Diagnostics & Maintenance

- `roll doctor --json` — system health check. Now also includes per-agent runtime env drift detection: Roll calls each running agent's diagnostic tool (`browser_status` / `diagnostic_status`) to fetch declared env keys' `{present, fingerprint}`, then compares against `agents.env` in `roll.config.yaml`. Output labels include `✓ from yaml (stable)` / `⚠ differs from yaml (ephemeral)` / `⚠ from shell (ephemeral)` / `✗ missing`.
- `roll update --check` — check available updates for roll-core and all registered agents without applying.
- `roll update` — apply all available updates (lifecycle varies by source type).
- `roll config migrate` — run when doctor or update reports `needs-migration`.

For output formats, status icons, update lifecycle details, and follow-up actions, see [references/workflows.md](./references/workflows.md).

## Output Handling

- Parse JSON from stdout.
- Treat non-zero exit codes as failures or gated states.
- For `roll ask --json`, handle `success`, `needs_input`, `needs_confirmation`, and `failed`.
- Treat `roll ask` as single-shot. For multi-step workflows, chain explicit `roll run` calls.

## References

- For first-time machine setup, config migration, and **the difference between `roll agent add` (local source) vs `roll agent install` (published package)**, read [references/setup.md](./references/setup.md).
- For multi-step Roll CLI recipes and troubleshooting sequences, read [references/workflows.md](./references/workflows.md).
- For common Roll-layer failures and recovery paths, read [references/errors.md](./references/errors.md).
- For cross-agent sequencing, verification patterns, and shared orchestration pitfalls, read [references/cross-agent-orchestration.md](./references/cross-agent-orchestration.md).
- For tool input/output details, env declarations, and capability boundaries, read the target subagent's own `SKILL.md` or runtime metadata.
