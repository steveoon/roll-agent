---
"@roll-agent/relay-protocol": minor
"@roll-agent/relay-client": minor
"@roll-agent/companion": minor
"@roll-agent/core": patch
---

Preserve bounded legacy context recovery event transport through opt-in Relay Wire 1.3. New summary-based sessions have no active recovery gate. Existing Relay deployments continue using Wire 1.2 until the service and Companion are upgraded together.
