---
"@roll-agent/core": patch
---

Fix Windows standalone installation and updates for deeply nested package paths without requiring system long-path policy changes or a preinstalled Node.js. The PowerShell installer bootstraps the bundled Node and a self-contained installation helper; installation and updates share bounded ZIP validation and extraction, including CRC checks and Windows path collision protection.

Allow existing standalone users to upgrade through the online installer while preserving Agent usage locks, scheduler admission and target-runtime service coordination. Older Windows installations whose updater hits the legacy path limit can use the updated stable installer once, then resume using `roll update`.
