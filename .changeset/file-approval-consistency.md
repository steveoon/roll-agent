---
"@roll-agent/runtime": patch
"@roll-agent/core": patch
"@roll-agent/protocol": minor
"@roll-agent/client-node": patch
---

Bind edit_file and write_file approvals to each call's original file version, preventing stale previews from authorizing writes after another call changes the file. Preserve the existing edit matching and all-or-fail planning behavior.

Replace the handwritten diff implementation with bounded jsdiff rendering and retain complete approval review snapshots. Add CLI review navigation and the Runtime 1.6 approval.preview pagination method; render explicit before/after text when line diff generation exceeds its budget.

Reuse the approved display snapshot after a successful write and calculate CLI review pages only when opened. Distinguish truncated previews from complete changes and preserve missing-final-newline markers in the full-text fallback.

For third-party Runtime UIs, complete review is an optional local Runtime 1.6 integration: check the negotiated version and `preview.fullDiffAvailable`, then follow `nextOffset` to read the stable, redacted snapshot while the approval remains pending. Existing approval control flows for older negotiated versions remain unchanged. This method does not extend the Relay remote-access allowlist; remote Web clients do not gain full file-diff review through this release.

File-tool operation displays carry `{ text, diff }` rather than only a string. Render `truncated` previews as incomplete, and treat `coarse: true` as a full-text comparison whose counts describe the whole before/after files rather than precise added/removed lines.
