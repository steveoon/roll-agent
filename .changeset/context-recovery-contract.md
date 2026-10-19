---
"@roll-agent/runtime": patch
"@roll-agent/core": patch
"@roll-agent/protocol": minor
"@roll-agent/client-node": minor
---

Retain Runtime Protocol 1.6 recovery snapshot and durable event compatibility, with bounded projections for older clients and Node Client. New summary-based sessions report no active recovery gate; older persisted recovery events remain readable without restoring mandatory readback behavior.
