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
