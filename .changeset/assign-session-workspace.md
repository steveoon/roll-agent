---
"@roll-agent/runtime": minor
---

Add an explicit ThreadStore operation to assign unclassified interactive history to a workspace while retaining the existing session ownership checks. Preserve conversation identity, timestamps, messages, checkpoints and execution history; reject reassignment to another project and changes to scheduled execution provenance.
