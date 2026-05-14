---
"@roll-agent/browser-use-agent": minor
"@roll-agent/browser": minor
"@roll-agent/sdk": minor
"@roll-agent/core": minor
---

Add browser security policy and browser-use tool confirmation policy.

- Add env-driven browser hard boundaries for domain allowlists, action policy decisions, and output caps.
- Add browser-use tool-level policy with one-time approval tokens for confirm-gated tools.
- Gate `zhipin_send_prepared_reply` with non-consuming prepared reply inspection and approval retry support.
- Add structured tool errors in the SDK and expose them through `roll run --json`.
- Surface browser security and tool policy summaries in `browser_status` and `roll doctor`.
