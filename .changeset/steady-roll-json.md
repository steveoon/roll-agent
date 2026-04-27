---
"@roll-agent/core": patch
"@roll-agent/browser-use-agent": patch
---

Fix `roll run` JSON object input handling and add browser-use diagnostics for BOSS page attach state.

`roll run` now accepts a third positional JSON object as explicit tool input while keeping
`--input-json` as the recommended orchestration-safe form. `browser-use-agent` also adds
`zhipin_diagnose_browser_state` for inspecting BOSS native page selection, attach state, page
readiness, and automation fingerprint exposure.
