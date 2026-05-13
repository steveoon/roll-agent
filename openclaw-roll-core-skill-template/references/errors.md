# Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `Agent not found` / no registered agent matches | Agent was not registered, or the wrong name was used | Run `roll agent list`; then `roll agent info <agent-name>` |
| `Tool not found` / schema mismatch | Wrong tool name, or the subagent contract changed | Run `roll agent tools <agent-name> --json` to fetch current tool names and input schemas from stdout. Treat any stderr `Did you mean: ...` line as a hint, then re-discover instead of guessing. If schemas drifted, re-register the local-path agent |
| Orchestrator behavior follows stale agent instructions | The orchestrator used embedded skill text instead of the currently registered agent skill | Run `roll skills get <agent-name> --include-references --json`, read `content` and `references[]`, then re-check `roll agent tools <agent-name> --json` |
| `batch 模式不接受 agent/tool 位置参数` | `roll run --batch-*` was combined with positional `agent tool` | Use `roll run --batch-stdin --json` and put `agent` / `tool` in each JSON item |
| Batch command exits non-zero | One or more batch items failed; previous items may still have succeeded | Parse stdout JSON array, branch on each item's `ok`, and retry only the failed/recoverable items |
| Connection error / timeout | Target agent is a persistent service and is not healthy | Run `roll agent info <agent-name>` to confirm runtime ownership, then `roll agent health --json`; if Roll owns lifecycle, run `roll agent start <agent-name>` |
| `roll agent health --json` reports sidecar version mismatch | Runtime metadata was created by another Roll version | If `runtime ownership` is `core-managed`, run `roll agent stop <agent-name>` then `roll agent start <agent-name>`; if external-managed, report the mismatch |
| `roll agent health --json` reports orphan sidecar / stale runtime metadata | Metadata exists but the recorded process is gone or unrelated | Run `roll doctor --fix --json`, then `roll agent health --json` again |
| `roll agent health --json` reports PID mismatch | Sidecar PID does not match the process Roll is checking | Restart only core-managed agents; for external-managed agents, report the process mismatch to the user |
| `needs_input` from `roll ask --json` | The router found a tool, but required inputs could not be extracted safely | Read both arrays from stdout JSON: `validationIssues` (input schema) and `runtimeIssues` (runtime prerequisites). The mirrored two-section message on stderr is diagnostic only. Switch to `roll run <agent> <tool> --input-json '{...}' --json` after resolving both |
| Tool error with `cause: ...` line in stderr | The target agent wrapped an upstream error with `Error.cause`; Roll prints it below the main message | Read the stderr `cause: ...` line for the original error (URL, `timeoutMs`, `requestId`, upstream HTTP status, etc.). Stdout remains the tool/JSON payload channel. Use `requestId` to correlate with upstream service logs |
| `needs_confirmation` from `roll ask --json` | Routing confidence was below the confirm threshold | Confirm the agent/tool explicitly, or bypass routing with `roll run` |
| `roll agent install /path/to/local-agent` fails | A local source directory was treated like a package spec | Use `roll agent add /path/to/agent` instead |
| Agent tool returns 401 / missing config / wrong endpoint behavior | Agent runtime did not receive required env vars, or upstream provider rejected the supplied key | First run `roll doctor --json` for drift summary, then `roll agent info <agent-name>` for per-key runtime labels. Update `agents.env.<agent-name>` in `roll.config.yaml`, restart or re-register as needed, and only after that verify provider/key validity |
| Local-path agent behavior does not match current source tree | Registration metadata is stale after upstream edits | Run `roll agent remove <agent-name>` and `roll agent add /path/to/agent` again |

Subagent-specific business errors should be diagnosed against that subagent's own docs rather than this shared Roll skill.
