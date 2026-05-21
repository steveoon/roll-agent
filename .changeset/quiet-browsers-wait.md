---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": minor
"@roll-agent/core": patch
---

Add browser foreground policy control for native CDP interactions.

Browser security config now supports `foregroundPolicy` with a default of `when-minimized`, so native browser actions only call `Page.bringToFront` when the target Chrome window is minimized. `browser-use-agent` applies the policy across generic ref actions and Zhipin native tools, and browser diagnostics now report the effective policy.
