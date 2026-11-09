---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
"@roll-agent/protocol": minor
"@roll-agent/client-node": minor
---

Expose optional Protocol 1.6 model catalog and per-conversation get/set APIs through client-node. Selections are process-local, isolated from other conversations including MCP Sampling, and discarded on detach or restart. Clients decide whether to save and explicitly restore a choice. Selection does not modify configuration or history metadata and adds no database migration; CLI model selection and scheduler engine behavior remain unchanged.

Reject model mutations for detached conversations without reopening or reacquiring them. Coordinate model preparation with opening, configuration reload and shutdown, report default-model application failures accurately, and build new sessions exclusively from the current model parameters.
