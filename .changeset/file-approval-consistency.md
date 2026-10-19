---
"@roll-agent/runtime": patch
"@roll-agent/core": patch
"@roll-agent/protocol": minor
"@roll-agent/client-node": patch
---

Bind edit_file and write_file approvals to each call's original file version, preventing stale previews from authorizing writes after another call changes the file. Preserve the existing edit matching and all-or-fail planning behavior.

Replace the handwritten diff implementation with bounded jsdiff rendering and retain complete approval review snapshots. Add CLI review navigation and the Runtime 1.6 approval.preview pagination method; render explicit before/after text when line diff generation exceeds its budget.

Reuse the approved display snapshot after a successful write and calculate CLI review pages only when opened. Distinguish truncated previews from complete changes and preserve missing-final-newline markers in the full-text fallback.
