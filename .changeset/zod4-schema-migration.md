---
"@roll-agent/sdk": major
"@roll-agent/core": major
"@roll-agent/runtime": major
"@roll-agent/browser": major
"@roll-agent/reply-authority-client": major
"@roll-agent/protocol": minor
"@roll-agent/relay-protocol": patch
"@roll-agent/relay-client": patch
"@roll-agent/companion": major
"@roll-agent/browser-use-agent": patch
"@roll-agent/smart-reply-agent": patch
---

Upgrade Zod to 4.6.6 to address oversized-array validation denial of service
(GHSA-mrhx-c7xc-m3w5). SDK tool schemas and the exported Core, Runtime, Browser,
Companion, and Reply Authority Client schemas now use Zod 4; TypeScript consumers using
Zod 3 must migrate their schema definitions and composition. See
`docs/how-to-migrate-zod4.md` for the required changes.

Preserve nested configuration defaults, YAML key mapping, configuration UI
constraints, tool preprocessing/refinements, and application-output validation.
Runtime and Relay wire versions and payload formats remain unchanged; Protocol
1.6 envelopes retain strict validation and capability checks with Zod 4.6.
Protocol now exports `uuidSchema` so Relay can share the frozen UUID validation;
existing UUID and timestamp acceptance and Relay schema fingerprints are preserved.
Standalone installer builds resolve subpath manifests to the owning package so
that the bundled Zod license is included correctly.
