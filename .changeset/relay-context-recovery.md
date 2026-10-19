---
"@roll-agent/relay-protocol": minor
"@roll-agent/relay-client": minor
"@roll-agent/companion": minor
"@roll-agent/core": patch
---

Preserve bounded legacy context recovery event transport through opt-in Relay Wire 1.3. New summary-based sessions have no active recovery gate. Companion continues to use Wire 1.2 by default, and the browser Relay Client continues to advertise Wire 1.2 and 1.1 by default. Enable Wire 1.3 explicitly only after the Relay service, Companion and browser client all support it; upgrading Roll alone does not enable Wire 1.3.
