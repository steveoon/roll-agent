---
"@roll-agent/runtime": patch
---

Make `roll__skill` tolerate empty and main-document reference aliases so models can reliably load
the primary `SKILL.md`, while preserving the existing references directory sandbox.
