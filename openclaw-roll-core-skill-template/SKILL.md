---
name: roll-core
description: Use the `roll` CLI to invoke registered MCP agents, manage their lifecycle, and route user intents through `roll run --json`, `roll ask --json`, `roll agent start`, `roll agent health`, and `roll agent install`. Trigger when a skill-capable orchestrator or coding agent should operate `browser-use-agent`, `smart-reply-agent`, or other installed Roll agents through a stable CLI surface.
---

# Roll Core

Prefer deterministic execution.

- Use `roll run --json` when the target agent and tool are known.
- Use `roll ask --json` only when intent is known but the target agent/tool is not.
- Do not default to `roll chat`; it is still experimental.

## Startup Gate

Run `roll agent health --json` before any `browser-use-agent` tool call.

- If `browser-use-agent` is unhealthy, run `roll agent start browser-use-agent`.
- If login state is uncertain, verify it with `roll run browser-use-agent zhipin_get_username --json`.
- Treat `browser-use-agent` as a persistent HTTP service. It must be healthy before tool calls.
- Treat `smart-reply-agent` as on-demand. It does not need pre-start.

## Output Handling

- Parse JSON from stdout.
- Treat non-zero exit codes as failures or gated states.
- For `roll ask --json`, handle `success`, `needs_input`, `needs_confirmation`, and `failed`.
- Treat `roll ask` as single-shot. For multi-step workflows, chain explicit `roll run` calls.

## References

- For first-time machine setup, config migration, login gates, and **the difference between `roll agent add` (local source) vs `roll agent install` (published package)**, read [references/setup.md](./references/setup.md).
- For `browser-use-agent` tool catalog, page context rules, and navigation behavior, read [references/browser-use-agent.md](./references/browser-use-agent.md).
- For `smart-reply-agent` capability boundaries and input expectations, read [references/smart-reply-agent.md](./references/smart-reply-agent.md).
- For multi-step command recipes, read [references/workflows.md](./references/workflows.md).
- For common failures and recovery paths, read [references/errors.md](./references/errors.md).
