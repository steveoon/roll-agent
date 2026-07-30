---
"@roll-agent/relay-protocol": minor
"@roll-agent/companion": minor
---

Extract the versioned, Browser-safe Relay Protocol and conformance suite into a
standalone package while keeping Companion compatibility exports. Make replay
classification request-identity aware, expose exact method dispositions to
cross-language consumers, and fail a Relay transport generation on ordered-send
errors so events and cached mutation responses recover without duplicate Runtime
execution or ACK gaps.
