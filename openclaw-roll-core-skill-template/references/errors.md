# Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `Agent not found` / no registered agent matches | Agent was not registered, or the wrong name was used | Run `roll agent list`; then `roll agent info <agent-name>` |
| `Tool not found` / schema mismatch | Wrong tool name, or the subagent contract changed | Run `roll agent tools <agent-name>` to list current tool names and input schemas. Roll's stderr also prints "Did you mean: ..." fuzzy suggestions when the name is close enough. If schemas drifted, re-register the local-path agent |
| Connection error / timeout | Target agent is a persistent service and is not healthy | Run `roll agent info <agent-name>` to confirm runtime ownership, then `roll agent health --json`; if Roll owns lifecycle, run `roll agent start <agent-name>` |
| `needs_input` from `roll ask --json` | The router found a tool, but required inputs could not be extracted safely | Collect the missing fields **and** any runtime prerequisites from the response. The payload splits them into `validationIssues` (input schema) and `runtimeIssues` (env etc.); both lists are returned at once. Switch to `roll run <agent> <tool> --input-json '{...}' --json` after resolving both |
| Tool error with `cause: ...` line in stderr | The target agent wrapped an upstream error with `Error.cause`; Roll prints it below the main message | Read the `cause` line for the original error (URL, timeoutMs, requestId, upstream HTTP status, etc.). Use the `requestId` to correlate with upstream service logs |
| `needs_confirmation` from `roll ask --json` | Routing confidence was below the confirm threshold | Confirm the agent/tool explicitly, or bypass routing with `roll run` |
| `roll agent install /path/to/local-agent` fails | A local source directory was treated like a package spec | Use `roll agent add /path/to/agent` instead |
| Agent tool returns 401 / missing config / wrong endpoint behavior | Agent runtime did not receive required env vars, or upstream provider rejected the supplied key | First check `roll agent info <agent-name>` env section; then update `agents.env.<agent-name>` in `roll.config.yaml`; only after that verify provider/key validity |
| Local-path agent behavior does not match current source tree | Registration metadata is stale after upstream edits | Run `roll agent remove <agent-name>` and `roll agent add /path/to/agent` again |

Subagent-specific business errors should be diagnosed against that subagent's own docs rather than this shared Roll skill.
