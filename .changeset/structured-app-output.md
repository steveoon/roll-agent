---
"@roll-agent/sdk": minor
"@roll-agent/core": minor
"@roll-agent/runtime": minor
"@roll-agent/protocol": minor
"@roll-agent/client-node": minor
"@roll-agent/companion": minor
"@roll-agent/relay-protocol": minor
"@roll-agent/relay-client": minor
---

Add opt-in structured App results so third-party clients can render their own UI from Subagent data.

- Publish portable output contracts through MCP and store complete, validated results independently of lossy model/display projections.
- Add Runtime Protocol 1.5 and Relay Wire 1.2 result queries, lightweight operation descriptors, and typed Node/Relay client APIs while preserving older wire projections.
- Require both producer opt-in and an exact, live host tool grant for remote reads; avoid caching completed result responses across authorization changes.
- Preserve completed execution in `roll run` and `roll ask` when an opted-in tool reports invalid or oversized App output, exposing `appOutputStatus` without automatically repeating the operation.
- Distinguish credential-content rejection (`rejected`, with safe diagnostics) from access denial (`denied`), preserve ordinary business fields, and isolate invalid Roll output declarations from healthy tools.
- Keep result reads free of retention writes and preserve original expiry across history recovery and forks.
