---
"@roll-agent/runtime": patch
---

Fix context compaction failing with sourceQuotes length validation errors when long conversation text contains emoji or other supplementary Unicode characters. Bound semantic evidence and checkpoint text using the same UTF-16 limits as validation, without splitting surrogate pairs.
