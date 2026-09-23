---
"@roll-agent/runtime": minor
"@roll-agent/core": patch
---

Honor explicit, bounded MCP tool metadata `roll/executionTimeoutMs` in Runtime, `roll run`, and `roll ask`, while preserving Runtime's turn cancellation signal. Tools without a valid declaration keep the existing MCP timeout. This allows agent-local browser loops to complete without being interrupted by the default per-request deadline.
