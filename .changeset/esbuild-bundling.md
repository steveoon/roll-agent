---
"@roll-agent/sdk": patch
"@roll-agent/browser": patch
"@roll-agent/browser-use-agent": patch
"@roll-agent/smart-reply-agent": patch
---

build: bundle published packages into single JS files via esbuild

Replace multi-file tsc output with esbuild single-file bundles to eliminate
internal file structure from dist/. Build pipeline is now
tsc --emitDeclarationOnly → esbuild bundle → terser minification.
.d.ts files preserved as-is for TypeScript consumers.
