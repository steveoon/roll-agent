---
"@roll-agent/browser-use-agent": minor
"@roll-agent/reply-authority-client": minor
---

Preserve redacted request/phase/latency diagnostics when `zhipin_generate_reply_preview` fails (including `clientTimeoutMs` for the Roll transport budget), raise the shared Reply Authority client timeout default from 30s to 60s so it stays above the RFC complete-request deadline, and declare `REPLY_AUTHORITY_TIMEOUT_MS` in browser-use env diagnostics.
