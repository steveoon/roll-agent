---
"@roll-agent/runtime": patch
---

Commit Protocol 1.2+ capability acknowledgements behind the JSON-RPC response barrier so an
Interaction created inside the ACK window can no longer reach the client before the ACK frame
and die with -32601. Withdrawal cancellations stay synchronous while acknowledgement and
delivery run after the response is written, which also closes the same race on revision upgrades,
without changing the existing public coordinator setter. Approvals additionally gain the same
absolute deadline fallback as user input (`min(now + 5 minutes, remaining turn lifetime)`) so
embedding without `turnTimeoutMs` no longer causes every Protocol 1.2 approval to fail closed, and user input
results are normalized against an immutable copy of the original form at both the RuntimeService
boundary and inside the engine before reaching the model.
