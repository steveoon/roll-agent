# Workflows

## Inventory And Preflight

```bash
roll agent list
roll agent info <agent-name>
roll agent health --json
```

Use this order when the target agent is not yet fully understood:
- `roll agent list` to confirm the registered name
- `roll agent info <agent-name>` to inspect source, transport, runtime ownership, and env status
- `roll agent health --json` before calling tools on persistent agents

## Known Agent + Tool

```bash
roll run <agent-name> <tool-name> --input-json '{...}' --json
```

## Known Intent, Unknown Tool

```bash
roll ask "<natural-language intent>" --json
```

Handle `roll ask --json` like this:
- `success`: run is complete
- `needs_input`: gather missing arguments, then switch to `roll run`
- `needs_confirmation`: confirm the agent/tool explicitly, or bypass with `roll run`
- `failed`: inspect routing and target-agent state

## Persistent Agent Recovery

```bash
roll agent info <agent-name>
roll agent health --json
roll agent start <agent-name>
roll agent health --json
```

Use this only when `roll agent info <agent-name>` shows a persistent runtime.

## Local-Path Agent Refresh

```bash
roll agent remove <agent-name>
roll agent add /path/to/agent
roll agent info <agent-name>
```

Use this after upstream edits to:
- `SKILL.md`
- manifest/runtime metadata
- env declarations
- tool names or schemas

## Check & Update Agents

```bash
roll update --check
```

Use this to inspect available updates before applying. For `installed-package` agents, the output includes real npm version comparison (up-to-date / update-available / pinned-behind / unsupported-spec / unknown).

To apply all updates:

```bash
roll update
```

For `installed-package` + `core-managed` agents, the update lifecycle is: stop → npm install → re-discover → setup → update store → restart. Note: setup may fail (e.g. browser runtime install), in which case the agent is marked `error` and a retry command is printed. For `pinned-behind` agents, `npm install` uses the original fixed spec — it will not auto-upgrade to latest.

Both `roll update --check` and `roll update` also inspect the local config file. If the config `needs-migration` or is `invalid`, a notice is printed with suggested fix (`roll config migrate`).

## System Diagnostics

```bash
roll doctor --json
```

Use this when tool calls fail unexpectedly or env setup is unclear. Checks Node.js version, config validity, LLM provider keys, data directory, registered agents, and per-agent env requirements.

`--json` outputs `CheckResult[]` where each entry has `status: "ok" | "warn" | "fail"`. Non-zero exit code when any check is `fail`.

Follow-up based on output:
- `needs-migration` → `roll config migrate`
- Missing env → configure `agents.env` in `roll.config.yaml`
- Agent count is 0 → `roll agent install <package>` or `roll agent add <path>`

## Tool Call Failure Triage

```bash
roll agent info <agent-name>
roll agent health --json
roll run <agent-name> <tool-name> --input-json '{...}' --json
```

Diagnose in this order:
1. Is the agent registered under the expected name?
2. Does `roll agent info` report missing env?
3. Is the agent a persistent service that must be healthy before tool calls?
4. Does the target subagent's own doc still advertise the same tool name and input schema?
