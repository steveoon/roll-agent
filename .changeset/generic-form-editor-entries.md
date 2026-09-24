---
"@roll-agent/browser-use-agent": patch
---

Distinguish display-only form editor entries from actual value controls. Preserve independently judged field-to-entry relationships across local editor transitions, invalidate summary evidence when values change, and include surrounding field meaning in binding choices. Keep related delegated fields visible in shared editors without granting ownership of unrelated pickers. Reuse the existing decision request for current summary judgments without per-field host calls or site-specific field types.
