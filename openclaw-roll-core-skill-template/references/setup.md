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

# 5. Install browser-use-agent
roll agent install @roll-agent/browser-use-agent

# 6. Start browser-use-agent
roll agent start browser-use-agent

# 7. Open the target platform
roll run browser-use-agent open_platform --input-json '{"platform":"zhipin"}' --json
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

### D. Important caveat for `npm pack` / `.tgz`

If a local agent uses monorepo dependencies such as:

```json
"@roll-agent/sdk": "workspace:*"
```

then `npm pack` + `roll agent install xxx.tgz` may fail with npm `EUNSUPPORTEDPROTOCOL`.

In that case, either:
- use `roll agent add /path/to/agent`, or
- replace `workspace:*` dependencies with real version numbers before packing.

## Agent env and re-registration pitfalls

### 1. Re-register after upstream updates

If a local-path agent source code was updated, re-register it so Roll can re-read the latest `SKILL.md`, manifest metadata, and env declarations:

```bash
roll agent remove <agent-name>
roll agent add /path/to/agent
```

This is especially useful after upstream changes to:
- `SKILL.md`
- `references/setup.md`
- `references/env.yaml`
- env metadata / required variables

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

## Important Notes

- `browser-use-agent` now defaults to system Chrome. Installation does not default to Playwright Chromium download.
- Login is still a manual step. Wait for the user to finish QR-code scan or credential entry before proceeding.
- Verify login with:

```bash
roll run browser-use-agent zhipin_get_username --json
```

- If this returns a username, the session is active.

## Subsequent Sessions

After first-time setup, the common path is:

```bash
roll agent start browser-use-agent
roll agent health --json
```
