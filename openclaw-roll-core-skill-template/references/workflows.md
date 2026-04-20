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
- `needs_input`: gather missing arguments, then switch to `roll run`. The JSON payload contains two separate lists:
  - `validationIssues` — input schema fields (recursively expanded from parent missing to leaf, shown once per field)
  - `runtimeIssues` — runtime prerequisites (e.g. missing env). Configure `agents.env.<agent-name>` in `roll.config.yaml` or export before retrying.
- `needs_confirmation`: confirm the agent/tool explicitly, or bypass with `roll run`
- `failed`: inspect routing and target-agent state

Both lists are surfaced at once, not layer-by-layer. Collect all fields and env keys in a single pass before retrying.

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

## Env Drift Detection

When a tool fails with an env-related symptom (e.g. upstream 401, missing config, unexpected endpoint behavior), don't assume `roll.config.yaml` alone is authoritative — the agent process may have been started before the yaml update, or may be inheriting values from the shell.

```bash
roll doctor --json
roll agent info <agent-name>
```

Both commands now call the target agent's diagnostic tool (if running) and compare declared env keys with yaml declarations. Expect one of these status labels per key:

- `✓ from yaml (stable)` — agent process sees the value and its fingerprint matches yaml
- `⚠ differs from yaml (ephemeral)` — agent process sees a value that does **not** match yaml; likely stale after a config edit, or shadowed by shell export
- `⚠ from shell (ephemeral)` — yaml did not declare, but agent process has it (inherited from shell)
- `✗ missing` — yaml declared, agent process does not have it

Remediation:
- Drift on `ephemeral` keys → `roll agent stop <name>` then `roll agent start <name>` (persistent services) or `roll agent remove` + `roll agent add` (local-path) to pick up the new yaml.
- `✗ missing` → fix `agents.env.<agent-name>` then restart.
- If the agent is not running, drift cannot be verified and the label falls back to "未校验 / unverified".

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
