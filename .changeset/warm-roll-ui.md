---
"@roll-agent/core": minor
"@roll-agent/browser-use-agent": patch
"@roll-agent/smart-reply-agent": patch
---

Add the on-demand `roll ui` local configuration console with schema-derived forms, safe YAML editing, secret redaction, revision checks, and runtime activation planning.

Expose typed Agent environment metadata so both the CLI and configuration UI can reuse the same declarations.

Agent env declarations now fail closed: omitting `secret` is equivalent to `secret: true`, so authors must mark non-sensitive fields explicitly with `secret: false`.

Harden managed Agent activation with OS process-start identities so stale or legacy PID metadata fails closed instead of signaling a reused PID.
