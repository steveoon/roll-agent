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

Add opt-in structured App results with portable output contracts, independent durable storage, bounded read-only result retrieval, and client-owned rendering. Runtime Protocol 1.5 and Relay Wire 1.2 preserve older projections; remote results require both producer opt-in and an exact host tool grant. Output validation failures retain execution facts without automatically repeating a completed tool.

Harden first-release compatibility: downgrade Companion 1.2 snapshots for old Web clients, preserve identical mutation replay after reconnect, keep result reads free of retention writes, distinguish content rejection from authorization, and preserve completed execution in run/ask when App output is unavailable.
