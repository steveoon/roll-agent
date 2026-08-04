---
"@roll-agent/protocol": minor
"@roll-agent/runtime": minor
"@roll-agent/client-node": minor
"@roll-agent/core": patch
---

Add the Runtime Protocol 1.2 `userInput.request` interaction, including five bounded control
types, request-correlated result validation, safe pending projections, and a typed Node client
handler. Expose the built-in `roll__user_input` Tool only after capability acknowledgement, wait
in `waiting-for-user`, and settle cancellation, timeout, disconnect, or late responses exactly once.
