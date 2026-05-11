# Workflows

## Table of Contents

- [Inventory And Preflight](#inventory-and-preflight)
- [CLI-Served Skill Discovery](#cli-served-skill-discovery)
- [Known Agent, Unknown Tool](#known-agent-unknown-tool)
- [Known Agent + Tool](#known-agent--tool)
- [Batch Tool Calls](#batch-tool-calls)
- [Known Intent, Unknown Tool](#known-intent-unknown-tool)
- [Persistent Agent Recovery](#persistent-agent-recovery)
- [Local-Path Agent Refresh](#local-path-agent-refresh)
- [Check & Update Agents](#check--update-agents)
- [System Diagnostics](#system-diagnostics)
- [Env Drift Detection](#env-drift-detection)
- [Tool Call Failure Triage](#tool-call-failure-triage)

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

## CLI-Served Skill Discovery

```bash
roll skills list --json
roll skills get <agent-name> --include-references --json
roll skills path <agent-name>
```

Use this when an orchestrator needs the current agent instructions instead of stale bundled
knowledge.

| Command | Output | Use it for |
|---------|--------|------------|
| `roll skills list --json` | Registered skill names, descriptions, source labels, and optional paths | Build an agent inventory |
| `roll skills get <agent-name> --json` | `{ name, description, source, content, path? }` | Load the live `SKILL.md` text before planning tool calls |
| `roll skills get <agent-name> --include-references --json` | Skill document plus `references[]` | Load referenced `references/*` docs for deeper orchestration rules |
| `roll skills path <agent-name>` | Local `SKILL.md` path when available | Read adjacent references from a local-path agent |

Priority:
1. Use `roll skills get <agent-name> --include-references --json` for orchestration rules, stable
   identifier rules, and referenced workflow docs.
2. Use `roll agent tools <agent-name> --json` for the exact runtime schema.
3. Use local reference files only after `skills path` confirms a filesystem-backed skill.

Boundary:
- `roll skills get` is documentation, not runtime schema.
- `--include-references` only returns referenced local `references/*` files. If `source` is
  `registry`, `references` is empty because Roll does not have adjacent files.
- `roll agent tools` is schema, not workflow guidance.
- If `source` is `registry`, do not assume adjacent reference files exist on disk.

## Known Agent, Unknown Tool

```bash
roll agent tools <agent-name> --json
```

Use this when the target agent is known but the exact tool name or `inputSchema` is not.

- Parse the JSON from stdout.
- Use `roll agent tools <agent-name>` without `--json` only for manual inspection.
- If a prior `roll run` or `roll ask` printed `Did you mean: ...` in stderr, treat it as a hint and re-discover here instead of choosing a tool name blindly.

## Known Agent + Tool

```bash
roll run <agent-name> <tool-name> --input-json '{...}' --json
```

## Batch Tool Calls

```bash
roll run --batch-stdin --json
```

Use this when an orchestrator already has multiple explicit tool calls and wants one Roll process.
The stdin payload must be a JSON array:

```json
[
  { "agent": "browser-use-agent", "tool": "browser_status", "input": {}, "label": "status" },
  {
    "agent": "browser-use-agent",
    "tool": "zhipin_get_username",
    "input": {},
    "label": "recruiter"
  }
]
```

Batch item contract:

| Field | Required | Meaning |
|-------|----------|---------|
| `agent` | yes | Registered agent name |
| `tool` | yes | MCP tool name |
| `input` | no | JSON object, defaults to `{}` |
| `label` | no | Orchestrator label copied to the result |

Rules:
- Do not combine batch mode with positional `agent/tool`.
- Do not combine batch mode with `--input-json` or `--input-file`.
- Use `--bail` when later calls depend on all prior calls succeeding.
- Batch mode reduces CLI startup overhead, but it does not create implicit dataflow. The orchestrator
  still needs to read each result and construct the next explicit input.

## Known Intent, Unknown Tool

```bash
roll ask "<natural-language intent>" --json
```

Handle `roll ask --json` like this:

| `status` | Meaning | Next step |
|----------|---------|-----------|
| `success` | Run is complete | Stop |
| `needs_input` | Router found a tool, but safe execution still needs input or runtime prerequisites | Read both issue arrays, resolve all items in one pass, then switch to `roll run` |
| `needs_confirmation` | Routing confidence was below the confirm threshold | Confirm the agent/tool explicitly, or bypass with `roll run` |
| `failed` | Routing, connect, or execute stage failed | Inspect `stage`, stderr diagnostics, and target-agent state |

For `needs_input`, the stdout JSON contains:

| Field | Meaning | Remediation |
|-------|---------|-------------|
| `validationIssues` | Input schema fields. Parent missing objects are recursively expanded to leaf fields and shown once per field | Collect the values and pass them with `roll run <agent-name> <tool-name> --input-json '{...}' --json` |
| `runtimeIssues` | Runtime prerequisites such as missing env | Configure `agents.env.<agent-name>` in `roll.config.yaml` or export in the current shell before retrying |

Both arrays are returned at once, not layer-by-layer. Resolve the full set before retrying.

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
roll doctor --fix-plan --json
roll doctor --fix --json
```

Use this when tool calls fail unexpectedly or env setup is unclear. Checks Node.js version, config validity, LLM provider keys, data directory, registered agents, and per-agent env requirements.

`--json` outputs `CheckResult[]` where each entry has `name`, `status: "ok" | "warn" | "fail"`, and `message`. With `--fix-plan`, entries can include `fix`. With `--fix`, the JSON also includes fix results. Parse stdout only. For per-key env declaration and runtime labels, follow with `roll agent info <agent-name>`.

Follow-up based on output:
- `needs-migration` → `roll config migrate`
- Missing env → configure `agents.env` in `roll.config.yaml`
- Agent count is 0 → `roll agent install <package>` or `roll agent add <path>`
- Stale core-managed runtime metadata → `roll doctor --fix`
- Missing `agents.dataDir` → `roll doctor --fix`

Safe-fix boundary:
- `roll doctor --fix` only applies known safe repairs: config migration with backup,
  `agents.dataDir` creation, and orphan runtime metadata cleanup.
- It does not install packages, edit arbitrary env values, restart agents, or remove registered agents.

## Env Drift Detection

When a tool fails with an env-related symptom (e.g. upstream 401, missing config, unexpected endpoint behavior), don't assume `roll.config.yaml` alone is authoritative — the agent process may have been started before the yaml update, or may be inheriting values from the shell.

```bash
roll doctor --json
roll agent info <agent-name>
```

Use this pair when config and runtime may have drifted. `roll doctor --json` gives the fleet-level summary; `roll agent info <agent-name>` gives the per-key declaration and runtime labels.

| Command | What to read | Use it for |
|---------|--------------|------------|
| `roll doctor --json` | Fleet-level `CheckResult[]` summary such as `运行态漂移: ...` or `运行态缺失: ...` | Detect whether an env problem exists |
| `roll agent info <agent-name>` | Per-key declaration source plus runtime verification labels | Fix the exact key that drifted or is missing |

Per-key labels from `roll agent info <agent-name>`:

| Label | Meaning | Next step |
|-------|---------|-----------|
| `✓ from yaml (stable)` | Agent process sees the value and its fingerprint matches `agents.env` | None |
| `⚠ differs from yaml (ephemeral)` | Agent process sees a value that does **not** match `agents.env`; likely stale after a config edit or shadowed by shell export | Restart the persistent agent, or re-register the local-path agent |
| `⚠ from shell (ephemeral)` | YAML did not declare the key, but the agent process inherited it from the shell | Move the value into `agents.env.<agent-name>` if it must persist; then restart |
| `✗ missing` | YAML declared the key, but the running agent process does not have it | Fix `agents.env.<agent-name>` and restart |

Remediation:
- Drift on `ephemeral` keys → `roll agent stop <name>` then `roll agent start <name>` (persistent services) or `roll agent remove` + `roll agent add` (local-path) to pick up the new yaml.
- `✗ missing` → fix `agents.env.<agent-name>` then restart.
- If the agent is not running or exposes no diagnostic tool, `roll agent info <agent-name>` falls back to `运行态校验: 未校验（...）`. In JSON-oriented diagnostics, the underlying inspection state is `unverified`.

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
