---
"@roll-agent/relay-protocol": minor
"@roll-agent/relay-client": minor
"@roll-agent/companion": minor
"@roll-agent/core": patch
---

Preserve bounded legacy context recovery event transport through opt-in Relay Wire 1.3. New summary-based sessions have no active recovery gate. Companion continues to use Wire 1.2 by default, and the browser Relay Client continues to advertise Wire 1.2 and 1.1 by default. Enable Wire 1.3 explicitly only after the Relay service, Companion and browser client all support it; upgrading Roll alone does not enable Wire 1.3.

Keep remote App-result queries and capability reporting available when Companion negotiates Runtime 1.6, with the existing producer and host permission checks. Runtime Protocol and Relay Wire versions remain independent: the updated Companion projects Runtime 1.6 data to the existing Wire 1.2 contract without requiring a Relay 1.3 rollout.

Upgrade and restart the official Companion together with its bundled Runtime. The official host requires the bundled Runtime to negotiate its matching protocol version; mixing releases is not supported, even though ordinary Runtime clients retain older-version negotiation.
