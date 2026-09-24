---
"@roll-agent/browser": patch
---

Send Chromium's selectAll editing command with Meta+A on macOS so clear-before-type replaces existing text instead of deleting only the last character and appending. Preserve the existing input policy checks and omit editing commands from key-up events.
