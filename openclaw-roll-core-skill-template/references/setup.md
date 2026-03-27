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
# User must edit roll.config.yaml and set provider API keys

# 4. If an existing config uses deprecated schema, migrate it
roll config migrate

# 5. Register the target subagent
# Published package:
roll agent install <package-name>

# OR local source directory:
roll agent add /path/to/agent

# 6. Inspect runtime ownership, transport, and env status
roll agent info <agent-name>

# 7. If the agent is a persistent service, start it
roll agent start <agent-name>

# 8. Verify health before tool calls
roll agent health --json
```

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

Example:

```bash
roll agent install @roll-agent/browser-use-agent
```

### C. Important caveat for local `install`

Do **not** default to:

```bash
roll agent install /path/to/local-agent
```

This can mis-handle the local path as a package spec and fail during registration.

### D. Note on monorepo dependencies

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

If an agent declares its own env requirements, those values must be injected under:

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

Prefer `roll agent info <agent-name>` as the source of truth for required env:
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

If `roll agent info <agent-name>` still shows required env vars as missing, fix `agents.env.<agent-name>` first.

## Subsequent Sessions

After first-time setup, the common path is:

```bash
roll agent info <agent-name>
roll agent health --json
```

If the target agent is a persistent service and is not healthy:

```bash
roll agent start <agent-name>
roll agent health --json
```
