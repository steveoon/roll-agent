# Setup

## Fresh Machine

Use this sequence when `roll` is not installed yet:

```bash
# 1. Check Node.js
node --version
# Must be >= 22.6.0

# 2. Install roll-core
npm install -g @roll-agent/core
roll --version

# 3. Initialize config
roll config init
# `init` creates a minimal skeleton; prefer `roll config setup llm` for provider/model/API key.
roll config setup llm

# 4. If an existing config uses deprecated schema, migrate it
roll config migrate

# 5. Inspect fixable setup issues without mutating state
roll doctor --fix-plan --json

# 6. Optionally apply safe fixes only
roll doctor --fix --json

# 7. Register the target subagent
# Published package:
roll agent install <package-name>

# OR local source directory:
roll agent add /path/to/agent

# 8. Inspect runtime ownership, transport, and env status
roll agent info <agent-name>

# 9. If the registered agent declares required env, configure it interactively.
roll config explain agents.env.<agent-name>
roll config setup agent <agent-name>

# 10. If the agent is core-managed, start it through Roll.
# If it is external-managed, start the external service by its own runbook instead.
roll agent start <agent-name>

# 11. Verify health before tool calls
roll agent health --json
```

## Reply Authority V3 Compatibility

When deploying the current `browser-use-agent` dual-draft workflow:

```text
1. Deploy Reply Authority RFC V3
2. Verify the service accepts feedbackOutcome / decisionSource and returns feedbackExpiresAt
3. Deploy or update browser-use-agent
```

Do not deploy the new browser-use agent against an older Reply Authority feedback schema. Older Roll callers remain compatible with RFC V3, so the safe mixed-version window is **new service + old caller**, not the reverse.

## Config setup / explain

Use these when you need field documentation or guided edits without hand-writing YAML keys:

```bash
roll config explain              # list common paths
roll config explain install.registry
roll config setup llm
roll config setup install
roll config setup agent <agent-name>
```

Rules:

- `roll config explain [path]` — shows purpose, default behavior, examples, and the matching `roll config setup` command when available.
- `roll config setup [llm|install|agent] [agent-name]` — interactive wizard; **requires a TTY**.
  - In CI, pipes, or other non-interactive shells: use `roll config set <key> <value>` or edit `roll.config.yaml` directly; use `roll config explain <path>` for guidance.
  - User cancellation exits with a **non-zero** exit code; treat as failure in scripts.
  - Overwriting an existing file creates `roll.config.yaml.bak.<timestamp>` first.
- Agent secret env vars (names matching `TOKEN`, `KEY`, `SECRET`, or `PASSWORD`): if YAML already has a resolved value, **press Enter to keep it** instead of retyping.
- Plaintext secrets written to YAML trigger a warning; prefer `${ENV_VAR}` references and avoid committing config files.

## Local Agent Source vs Package Install

Use the right command for the right source type:

### A. Local source directory

If you have an agent checked out locally (for example from a Git repo), prefer:

```bash
roll agent add /path/to/agent
```

This is the correct path for source directories that contain `SKILL.md`, `package.json`, and source files.

### B. Published npm package

If the agent is published as an npm package, use:

```bash
roll agent install <package-name>
```

Examples:

```bash
roll agent install @roll-agent/browser-use-agent
roll agent install @roll-agent/smart-reply-agent
```

### C. Install network config

If `roll agent install` or `roll update` fails because the npm registry is slow or unreachable,
configure install networking through the setup wizard instead of changing package specs:

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

- `registry` is explicit opt-in. If omitted, Roll lets npm use its default registry.
- `fetch-retries` is passed to npm and also controls Roll-level whole-command retry attempts, capped at 3 total attempts.
- `prefer-offline` defaults to `false`; enable it only when stale npm metadata is acceptable for the workflow.
- `network-timeout-ms` controls the timeout for each npm install attempt.
- If the `install` section itself is invalid, `roll agent install` / `roll update` should stop instead of silently falling back to npm's default registry.

### D. Important caveat for local `install`

Do **not** default to:

```bash
roll agent install /path/to/local-agent
```

This can mis-handle the local path as a package spec and fail during registration.

### E. Note on monorepo dependencies

If an agent uses published dependency versions, it can usually be added as a standalone local-path target.

If an agent still uses `workspace:*` dependencies, either:
- use `roll agent add /path/to/agent` from within the monorepo, or
- replace `workspace:*` with real version numbers before standalone install.

## Agent env and re-registration pitfalls

### 1. Re-register after upstream updates

If a local-path agent source code was updated, re-register it so Roll can re-read the latest `SKILL.md`, manifest metadata, and env declarations:

```bash
roll agent remove <agent-name>
roll agent add /path/to/agent
```

This is especially useful after upstream changes to:
- `SKILL.md`
- runtime manifest metadata
- env metadata / required variables
- reference docs that describe capability boundaries

### 2. `llm:` config is not enough for agent runtime env

The top-level `llm:` section in `roll.config.yaml` is **not sufficient** for agents that read secrets or runtime configuration from environment variables.

If an agent declares its own env requirements, prefer the interactive setup/explain entry points:

```bash
roll config explain agents.env.<agent-name>
roll config setup agent <agent-name>
```

These commands read the env declarations registered from the subagent's own `SKILL.md` /
`roll-env-file` metadata. `setup agent` writes the resulting values under:

```yaml
agents:
  env:
    <agent-name>:
      SOME_API_KEY: ...
      SOME_BASE_URL: ...
      SOME_TOKEN: ...
```

In other words:
- `llm:` controls shared/default model routing
- `agents.env.<agent-name>` controls what the agent process actually receives at runtime

Prefer `roll config explain agents.env.<agent-name>` and `roll agent info <agent-name>` as the source of truth for required env:
- `config explain` shows purpose/example/default metadata and the setup command
- it reflects the env metadata declared by the subagent itself
- it shows which vars are still missing after registration
- it avoids hard-coding per-agent env lists into this shared Roll skill template

### 3. Symptom of missing agent env

A common symptom is:
- `roll doctor` looks normal
- agent registration looks normal
- some tools may work
- but tools that need LLM/API access fail with `401 Unauthorized`, missing config, or wrong endpoint behavior

In this case, check the agent runtime env before debugging model routing.

### 4. Fast verification path

Validate in this order:

```bash
roll agent info <agent-name>
roll run <agent-name> <tool-name> --input-json '{...}' --json
```

If `roll agent info <agent-name>` still shows required env vars as missing, run
`roll config explain agents.env.<agent-name>` and `roll config setup agent <agent-name>` first.
Then restart or re-register the agent
if it is persistent or if runtime labels still show stale values.

## Subsequent Sessions

After first-time setup, the common path is:

```bash
roll agent info <agent-name>
roll agent health --json
```

If the target agent is a `core-managed` persistent service and is not healthy:

```bash
roll agent start <agent-name>
roll agent health --json
```

For `external-managed` agents, report or fix the external endpoint/process instead of running
`roll agent start`.
