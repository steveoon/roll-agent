---
"@roll-agent/core": patch
---

Update transitive js-yaml dependencies to 3.15.2 and 4.3.2 to fix excessive CPU consumption when merging empty mappings (GHSA-2883-xcg3-v3hh). Both versions satisfy the existing seven-day release age policy, so the old version-specific exceptions are removed.
