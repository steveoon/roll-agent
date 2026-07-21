---
"@roll-agent/core": minor
"@roll-agent/runtime": patch
---

Add native xAI Grok model support, including configuration setup, the `grok-4.5` 500k context window, reasoning effort, and visible reasoning summaries in `roll chat`.

Keep nested `roll` commands on the same CLI instance that launched Chat, so development sessions no longer cross over to an older globally installed release. Preserve completed steps and redacted tool progress when a turn is interrupted, and replace technical cancellation notices with user-facing status copy.
