---
"@roll-agent/core": patch
---

feat: auto-detect local dev agents and fallback to type-stripping

When spawning on-demand stdio agents registered via `local-path` or `git`,
automatically fall back from `node dist/index.js` to
`node --experimental-strip-types src/index.ts` if the source file exists.
This unifies the dev fallback behavior already available for `core-managed`
agents (like browser-use) to also cover `on-demand` agents (like smart-reply).
