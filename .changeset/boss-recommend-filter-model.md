---
"@roll-agent/browser-use-agent": minor
---

Upgrade the BOSS recommend candidate filter tool to model the region selector and all visible filter panel fields through the native CDP workflow.

The browser-use skill now documents the recommend filter as a target-state contract, including region-to-district filtering, patch versus replace behavior, multi-select clearing, and stale candidate refs after filtering. The Roll core skill template now also reminds orchestrators that array inputs in state-setting tools are not automatically append operations.
