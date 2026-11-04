---
"@roll-agent/runtime": patch
---

Use the Windows namespaced executable path when launching bundled ripgrep so grep and glob tools work from installations whose ripgrep path exceeds 260 characters. POSIX execution and search behavior are unchanged.
