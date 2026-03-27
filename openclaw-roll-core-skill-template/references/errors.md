# Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `Agent not found` / no registered agent matches | Agent was not registered, or the wrong name was used | Run `roll agent list`; then `roll agent info <agent-name>` |
| `Tool not found` / schema mismatch | Wrong tool name, or the subagent contract changed | Re-check the target subagent's own `SKILL.md` / manifest; if needed, re-register the local-path agent |
| Connection error / timeout | Target agent is a persistent service and is not healthy | Run `roll agent info <agent-name>` to confirm runtime ownership, then `roll agent health --json`; if Roll owns lifecycle, run `roll agent start <agent-name>` |
| `needs_input` from `roll ask --json` | The router found a tool, but required inputs could not be extracted safely | Collect the missing fields and switch to `roll run <agent> <tool> --input-json '{...}' --json` |
| `needs_confirmation` from `roll ask --json` | Routing confidence was below the confirm threshold | Confirm the agent/tool explicitly, or bypass routing with `roll run` |
| `roll agent install /path/to/local-agent` fails | A local source directory was treated like a package spec | Use `roll agent add /path/to/agent` instead |
| Agent tool returns 401 / missing config / wrong endpoint behavior | Agent runtime did not receive required env vars, or upstream provider rejected the supplied key | First check `roll agent info <agent-name>` env section; then update `agents.env.<agent-name>` in `roll.config.yaml`; only after that verify provider/key validity |
| Local-path agent behavior does not match current source tree | Registration metadata is stale after upstream edits | Run `roll agent remove <agent-name>` and `roll agent add /path/to/agent` again |

Subagent-specific business errors should be diagnosed against that subagent's own docs rather than this shared Roll skill.
