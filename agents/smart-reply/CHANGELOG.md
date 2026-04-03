# smart-reply-agent

## 0.1.1

### Patch Changes

- [#26](https://github.com/steveoon/roll-agent/pull/26) [`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c) Thanks [@steveoon](https://github.com/steveoon)! - build: add terser minification and remove source maps from published packages
  - Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
  - Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
  - Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
  - `.d.ts` files remain intact for TypeScript consumers

- Updated dependencies [[`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c)]:
  - @roll-agent/sdk@0.1.4

## 0.1.0

### Minor Changes

- [#23](https://github.com/steveoon/roll-agent/pull/23) [`3f30c29`](https://github.com/steveoon/roll-agent/commit/3f30c2903017576c4fcc627e366b9e9253296760) Thanks [@steveoon](https://github.com/steveoon)! - feat(smart-reply): publish as public npm package with pipeline sub-path export
  - Rename from `smart-reply-agent` (private) to `@roll-agent/smart-reply-agent` (public)
  - Add `./pipeline` sub-path export exposing `generateSmartReply` and all related types
  - Add `rollAgent` manifest for stdio on-demand agent registration
  - Exclude test files from build output
  - Update SKILL.md with capability boundary, routing signals, and cross-agent workflow
  - Add `references/reply-policy-schema.md` documenting all configurable policy fields

## 0.0.2

### Patch Changes

- Updated dependencies [[`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e)]:
  - @roll-agent/sdk@0.1.2
