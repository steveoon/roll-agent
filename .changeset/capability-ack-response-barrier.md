---
"@roll-agent/runtime": minor
---

Commit Protocol 1.2+ capability acknowledgements behind the JSON-RPC response barrier so an
Interaction created inside the ACK window can no longer reach the client before the ACK frame
and die with -32601. `RuntimeClientRequestCoordinator.setResponderServerRequestMethods` now
returns a commit closure instead of taking a `deferDelivery` flag; withdrawal cancellations
stay synchronous while acknowledgement and delivery run after the response is written, which
also closes the same race on revision upgrades. Approvals additionally gain the same absolute
deadline fallback as user input (`min(now + 5 minutes, remaining turn lifetime)`) so embedding
without `turnTimeoutMs` no longer fails every 1.2 approval closed, user input results are
normalized against the original form inside the engine before reaching the model, and the
dead `RuntimeClientRequestOptions.threadId/turnId` fields were removed.
