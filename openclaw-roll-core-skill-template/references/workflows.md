# Workflows

## Table of Contents

- [Inventory And Preflight](#inventory-and-preflight)
- [CLI-Served Skill Discovery](#cli-served-skill-discovery)
- [Known Agent, Unknown Tool](#known-agent-unknown-tool)
- [Known Agent + Tool](#known-agent--tool)
- [Batch Tool Calls](#batch-tool-calls)
- [Known Intent, Unknown Tool](#known-intent-unknown-tool)
- [Browser Runtime Lifecycle](#browser-runtime-lifecycle)
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
roll skills get <agent-name> --json
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
1. Use `roll skills get <agent-name> --json` for first-pass planning from the live registered skill.
2. Add `--include-references` only when the task needs stable identifier rules, routing keys,
   recovery steps, or referenced workflow docs.
3. Use `roll agent tools <agent-name> --json` for the exact runtime schema.
4. Use local reference files only after `skills path` confirms a filesystem-backed skill.

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

Input can come from one of three sources:

| Source | Command | Use it when |
|--------|---------|-------------|
| Inline JSON | `roll run --batch-json '[...]' --json` | Small static batches |
| File | `roll run --batch-file ./batch.json --json` | Generated or large batches |
| Stdin | `roll run --batch-stdin --json` | Another process writes the batch |

The batch payload must be a JSON array:

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
- Parse stdout as a JSON array. Each result keeps `index`, `agent`, `tool`, optional `label`,
  `ok`, and either `result` or `error`.
- In batch mode, one failed item usually makes the process exit non-zero. Still read stdout JSON
  because it contains the per-item failure and any prior successful results.
- Batch mode reduces CLI startup overhead, but it does not create implicit dataflow. The orchestrator
  still needs to read each result and construct the next explicit input.
- Batch mode executes items sequentially and waits for each tool call to finish. It does not surface
  per-item streaming progress.
- Batch mode does not inherit routing keys. If a target agent uses a field such as `browserInstance`,
  `tenantId`, or `workspaceId`, put that field in every item `input`.
- For dependent workflows, split the workflow into multiple batches:
  read batch -> parse/filter results -> generate batch -> parse/filter results -> side-effect batch.

Example with an account/profile routing key:

```json
[
  {
    "agent": "browser-use-agent",
    "tool": "open_platform",
    "input": { "browserInstance": "boss-a", "platform": "zhipin" },
    "label": "boss-a-open"
  },
  {
    "agent": "browser-use-agent",
    "tool": "zhipin_get_username",
    "input": { "browserInstance": "boss-a" },
    "label": "boss-a-user"
  }
]
```

Result handling:

```text
batch stdout array
  -> for each item:
       ok=true  -> read result
       ok=false -> read error; decide retry/stop/recover
  -> never assume item N+1 consumed item N output
```

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
| `runtimeIssues` | Runtime prerequisites such as missing env | Prefer `roll config setup agent <agent-name>`; use `roll config explain agents.env.<agent-name>` to inspect required keys. Temporary shell exports are acceptable only for one-off retries |

Both arrays are returned at once, not layer-by-layer. Resolve the full set before retrying.

## Browser Runtime Lifecycle

Use this section for browser runtime cleanup without confusing it with agent service shutdown.

| Need | Command | Output/Effect |
|------|---------|---------------|
| Close one started browser runtime | `roll browser stop boss-a` | Closes `boss-a`; keeps `browser-use-agent` running; keeps profile/session data. |
| Close multiple started browser runtimes | `roll browser stop boss-a boss-b` | Closes only the listed instances; other started instances keep running. |
| Close all started browser runtimes | `roll browser stop --all` | Closes all browser runtimes managed by the current agent; the agent process stays available. |
| Delete browser profile/session data | `roll browser clear-data [browserInstance] --yes` | Deletes declared `userDataDir` / `sessionsDir` paths; run without `--yes` first for the dry-run plan. |
| Stop the service process | `roll agent stop browser-use-agent` | Stops `browser-use-agent`; later browser tool calls fail until the agent is started again. |

Decision flow:

```text
browser page/window/runtime stale
  -> read target agent SKILL/references for page-level reload/recovery tools
  -> run the documented recovery tool if available
  -> discard stale refs and re-read current page/list state
  -> if page recovery fails, roll browser stop <browserInstance>
  -> retry the target browser tool with the same browserInstance

all browser windows should close, service should stay usable
  -> roll browser stop --all

profile/session data must be reset
  -> roll browser clear-data [browserInstance]
  -> verify dry-run scope
  -> roll browser clear-data [browserInstance] --yes

service process unhealthy or env changed
  -> roll agent stop browser-use-agent
  -> roll agent start browser-use-agent
```

Boundary:
- `roll browser stop --all` is not the same as `roll agent stop browser-use-agent`.
- `roll browser stop` does not delete profile/session data.
- `roll browser clear-data` deletes declared browser data; it is not a runtime restart command.
- Do not scan operating-system browser processes or kill Chrome by port/path from orchestration code.

## Browser Page Recovery

Use this section when a page has stale in-document state, stale refs, broken selection, or a stuck SPA,
but the browser runtime and agent service are still responding.

Recovery order:

```text
roll skills get <agent-name> --include-references --json
  -> find the target agent's documented reload/recovery/semantic opener tools
  -> run the documented page recovery tool
  -> discard old @eN / business refs / page-derived handles
  -> run a fresh snapshot or domain-specific reader tool
  -> continue only with newly emitted refs and ids
```

Fallback:

```text
document/page recovery failed
  -> roll browser stop <browserInstance>
  -> reopen the platform/workflow with the same browserInstance
  -> re-read current state before side effects
```

Rules:

1. Prefer the target agent's recovery tool over raw URL navigation or runtime stop.
2. Never hardcode platform-internal recovery URLs in the shared Roll orchestrator.
3. Treat reload as page/document-state recovery, not guaranteed renderer memory reclamation.
4. Escalate to `roll browser stop` only when page-level recovery is unavailable or insufficient.
5. Escalate to `roll agent stop <agent-name>` only when `roll agent health --json` indicates the service process itself is unhealthy.

## Persistent Agent Recovery

```bash
roll agent info <agent-name>
roll agent health --json
# core-managed only:
roll agent start <agent-name>
roll agent health --json
```

Use this only when `roll agent info <agent-name>` shows a persistent runtime. If ownership is
`core-managed`, `roll agent start <agent-name>` can start or restart it; if ownership is
`external-managed`, fix the external service endpoint/process instead of asking Roll to start it.

For browser agents, distinguish process recovery from runtime recovery:

```bash
# Browser runtime/page state is broken, but the service is healthy:
roll browser stop boss-a
roll run browser-use-agent open_platform \
  --input-json '{"browserInstance":"boss-a","platform":"zhipin"}' --json

# Service process itself is unhealthy:
roll agent stop browser-use-agent
roll agent start browser-use-agent
roll agent health --json
```

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

`roll update --check` and `roll update` use the `install` section from `roll.config.yaml` for npm
version checks and npm installs:

```bash
roll config explain install.registry
roll config setup install
```

Equivalent YAML shape:

```yaml
install:
  registry: https://registry.npmmirror.com
  fetch-retries: 3
  prefer-offline: false
  network-timeout-ms: 120000
```

Rules:

- `registry` is opt-in; no registry value means npm default source.
- `fetch-retries` is applied to `npm view` / `npm install`; install commands also get Roll-level retry for network or timeout failures.
- `prefer-offline` defaults to `false` so update installs do not reuse stale npm metadata by default.
- Invalid `install` config stops update/install commands instead of silently switching to npm default source.

Both `roll update --check` and `roll update` also inspect the local config file. If the config `needs-migration` or is `invalid`, a notice is printed with suggested fix (`roll config migrate`). The `install` loader is independent from unrelated global migration notices, but the `install` section itself must be valid.

## System Diagnostics

```bash
roll doctor --json
roll doctor --fix-plan --json
roll doctor --fix --json
```

Use this when tool calls fail unexpectedly or env setup is unclear. Checks Node.js version, config validity, LLM provider keys, data directory, registered agents, and per-agent env requirements.

`--json` outputs `CheckResult[]` where each entry has `name`, `status: "ok" | "warn" | "fail"`, and `message`. With `--fix-plan`, entries can include `fix`. With `--fix`, the JSON also includes fix results. Parse stdout only. For per-key env declaration and runtime labels, follow with `roll agent info <agent-name>`.

Decision flow:

```text
unexpected failure / unknown setup
  -> roll doctor --json
      all ok:
        continue to agent-specific checks
      warn/fail:
        -> roll doctor --fix-plan --json
            no fix:
              report the check message and ask for explicit user action
            safe fix proposed:
              -> roll doctor --fix --json
              -> rerun roll doctor --json
```

Follow-up based on output:
- `needs-migration` → `roll config migrate`
- Missing env → `roll config explain agents.env.<agent-name>` then `roll config setup agent <agent-name>`
- Agent count is 0 → `roll agent install <package>` or `roll agent add <path>`
- Stale core-managed runtime metadata → `roll doctor --fix`
- Missing `agents.dataDir` → `roll doctor --fix`

Safe-fix boundary:
- `roll doctor --fix` only applies known safe repairs: config migration with backup,
  `agents.dataDir` creation, and orphan runtime metadata cleanup.
- It does not install packages, edit arbitrary env values, restart agents, or remove registered agents.

## Agent Health And Runtime Sidecar

```bash
roll agent info <agent-name>
roll agent health --json
```

Use this after `doctor` when a specific persistent agent still cannot be used.

Responsibilities:

| Command | Scope | Use it for |
|---------|-------|------------|
| `roll doctor --json` | Whole Roll installation | Config, data dirs, registered agents, env drift summary |
| `roll agent info <agent-name>` | One agent declaration | Source, transport, ownership, declared env, runtime env labels |
| `roll agent health --json` | One persistent runtime | Process/endpoint health and runtime sidecar consistency |

PR82 sidecar cases:

| Health symptom | Meaning | Orchestrator action |
|----------------|---------|---------------------|
| Version mismatch | Runtime metadata was written by another Roll version | Prefer `roll agent stop <agent-name>` then `roll agent start <agent-name>` if Roll owns lifecycle |
| Orphan sidecar / stale metadata | Sidecar exists but process is gone or unrelated | Run `roll doctor --fix --json`, then re-check health |
| PID mismatch | Metadata PID does not match the running process | Stop/start the core-managed agent; if external-managed, report to the user |
| Endpoint probe failed | Process metadata exists but MCP endpoint is not reachable | Start or restart only if `runtime ownership` is `core-managed` |

Boundary:
- `roll doctor --fix` can clean orphan core-managed runtime metadata.
- `roll doctor --fix` does not restart agents.
- `roll agent start` should be used only for agents Roll owns (`core-managed`).
- For `external-managed` agents, report the failing endpoint/process state instead of trying to
  control the process.

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
| `⚠ from shell (ephemeral)` | YAML did not declare the key, but the agent process inherited it from the shell | Run `roll config setup agent <agent-name>` to persist it if needed; then restart |
| `✗ missing` | YAML declared the key, but the running agent process does not have it | Run `roll config setup agent <agent-name>` or fix `agents.env.<agent-name>`, then restart |

Remediation:
- Drift on `ephemeral` keys → `roll agent stop <name>` then `roll agent start <name>` (persistent services) or `roll agent remove` + `roll agent add` (local-path) to pick up the new yaml.
- `✗ missing` → `roll config explain agents.env.<agent-name>`, then `roll config setup agent <agent-name>`, then restart.
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
