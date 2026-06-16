---
"@roll-agent/core": patch
---

Fix `roll update` for installed agents registered with a bare npm package name so it resolves the latest published version instead of reusing an old saved npm dependency range.
