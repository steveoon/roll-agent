---
"@roll-agent/core": patch
"@roll-agent/sdk": patch
"@roll-agent/browser": patch
"@roll-agent/browser-use-agent": patch
"@roll-agent/smart-reply-agent": patch
---

build: add terser minification and remove source maps from published packages

- Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
- Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
- Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
- `.d.ts` files remain intact for TypeScript consumers
