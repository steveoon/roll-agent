---
"@roll-agent/browser-use-agent": minor
---

Add BOSS recommend job selection support and expose scroll boundary state for dynamic lists.

The BOSS native CDP workflow can now select the active recommend-page job by stable
`jobValue`, `jobName`, or current dropdown `index`, and `zhipin_scroll_view` reports
top/bottom boundary fields so orchestrators can reason about virtual list position.
